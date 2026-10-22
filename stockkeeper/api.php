<?php
// api.php - the backend of our Stock Keeper system. Every request from the website comes here.
// The JS file calls it like api.php?action=something and we send the answer back as JSON.

session_set_cookie_params(["httponly" => true, "samesite" => "Lax"]);
session_start();
header("Content-Type: application/json; charset=utf-8");
mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT); // if the database has a problem, throw an error so we can catch it

/* ---------- small helper functions ---------- */
function out($data, $code = 200) {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}
function fail($msg, $code = 400) {
    global $conn;
    if (isset($conn)) { try { $conn->rollback(); } catch (Throwable $t) {} }
    out(["error" => $msg], $code);
}
set_exception_handler(function ($ex) {
    if ($ex instanceof mysqli_sql_exception) {
        if ($ex->getCode() == 1451) fail("Records are never deleted. Archive it instead", 409);
        if ($ex->getCode() == 1062) fail("That value already exists (duplicate name, SKU, email, username or receipt number)", 409);
        if (in_array($ex->getCode(), [3819, 4025])) fail("A value was rejected by the database rules", 422);
    }
    error_log($ex->getMessage());
    fail("Server error. Check that MySQL is running and db.php is correct.", 500);
});

require __DIR__ . "/db.php";

function rows($sql, $types = "", $args = []) {
    global $conn;
    $st = $conn->prepare($sql);
    if ($types !== "") $st->bind_param($types, ...$args);
    $st->execute();
    return $st->get_result()->fetch_all(MYSQLI_ASSOC);
}
function run($sql, $types = "", $args = []) {
    global $conn;
    $st = $conn->prepare($sql);
    if ($types !== "") $st->bind_param($types, ...$args);
    $st->execute();
    return $st;
}

/* dates for when a record was created, updated and archived (our system must track these) */
const DT  = "DATE_FORMAT(created_at, '%Y-%m-%d %H:%i') cr, DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i') up";
const DTA = DT . ", DATE_FORMAT(archived_at, '%Y-%m-%d %H:%i') ar";

/* ---------- roles and what each role can do (same list as in app.js) ---------- */
$ROLE_KEY = [1 => "admin", 2 => "manager", 3 => "inventory", 4 => "cashier"];
$ROLE_ID  = array_flip($ROLE_KEY);
$CAN = [
    "manage" => ["admin", "manager"],
    "users"  => ["admin"],
    "stock"  => ["admin", "inventory"],
    "sell"   => ["admin", "cashier"],
    "customers" => ["admin", "manager", "cashier"],
    "archive" => ["admin"],
];

/* One employee can have more than one role. We get them highest role first (admin, manager, inventory, cashier). */
function user_role_keys($uid) {
    global $ROLE_KEY;
    $out = [];
    foreach (rows("SELECT role_id FROM user_roles WHERE user_id = ? ORDER BY role_id", "i", [$uid]) as $r)
        $out[] = $ROLE_KEY[(int)$r["role_id"]];
    return $out;
}
function user_role_names($uid) {
    return array_column(rows("SELECT r.role_name n FROM user_roles ur JOIN roles r ON r.role_id = ur.role_id
                              WHERE ur.user_id = ? ORDER BY r.role_id", "i", [$uid]), "n");
}
/* If an employee has many roles, they can do everything that any of their roles can do. */
function can_do($u, $perm) {
    global $CAN;
    return (bool)array_intersect($u["roles"], $CAN[$perm]);
}
function is_admin($u) { return in_array("admin", $u["roles"], true); }

function current_user() {
    global $ROLE_KEY;
    static $u = false;
    if ($u !== false) return $u;
    $u = null;
    if (!empty($_SESSION["uid"])) {
        $r = rows("SELECT user_id, full_name, username, email, phone, job_title, status, " . DT . " FROM users WHERE user_id = ?", "i", [$_SESSION["uid"]])[0] ?? null;
        if ($r && $r["status"] === "Active") {
            $roles = user_role_keys((int)$r["user_id"]);
            $u = [
                "id"       => (int)$r["user_id"],
                "name"     => $r["full_name"],
                "username" => $r["username"],
                "email"    => $r["email"],
                "phone"    => $r["phone"] ?? "",
                "title"    => $r["job_title"] ?? "",
                "role"     => $roles[0] ?? "",   // the highest role, this is the one we show on screen
                "roles"    => $roles,        // all the roles of the employee
                "cr"       => $r["cr"],
                "up"       => $r["up"],
            ];
        }
    }
    return $u;
}
function need($perm = null) {
    $u = current_user();
    if (!$u) fail("Please sign in", 401);
    if ($perm && !can_do($u, $perm)) fail("Permission denied: your role cannot do this", 403);
    global $conn;
    $conn->query("SET @app_user_id = " . (int)$u["id"]); // so the database knows who made the change (for the history)
    return $u;
}

/* Saves a line in the activity log. Only the server does this so nobody can fake a log from the browser. */
function audit($text, $uid = null) {
    $text = mb_substr($text, 0, 500);
    if ($uid === null) { $cu = current_user(); $uid = $cu ? $cu["id"] : null; }
    if (preg_match('/^Signed in/', $text))             $code = "LOGIN";
    elseif (preg_match('/^Signed out/', $text))        $code = "LOGOUT";
    elseif (preg_match('/^Sale/', $text))              $code = "SALE_CREATE";
    elseif (preg_match('/^(Stock|Quantity)/', $text))  $code = "STOCK";
    elseif (preg_match('/archived|restored/i', $text)) $code = "UPDATE";
    elseif (preg_match('/added/i', $text))             $code = "CREATE";
    else                                               $code = "UPDATE";
    run("INSERT INTO activity_logs (user_id, action, description) VALUES (?, ?, ?)", "iss", [$uid, $code, $text]);
}

/* ---------- product and supplier links (one product can have many suppliers) ---------- */
/* Makes sure the main supplier of a product is still active. If not, we pick another active supplier to be the main one. */
function fix_primary($pid) {
    $cur = rows("SELECT s.archived_at FROM product_suppliers ps JOIN suppliers s ON s.supplier_id = ps.supplier_id
                 WHERE ps.product_id = ? AND ps.is_primary = 1", "i", [$pid])[0] ?? null;
    if ($cur && $cur["archived_at"] === null) return;
    $n = rows("SELECT ps.supplier_id FROM product_suppliers ps JOIN suppliers s ON s.supplier_id = ps.supplier_id
               WHERE ps.product_id = ? AND s.archived_at IS NULL ORDER BY ps.supplier_id LIMIT 1", "i", [$pid])[0] ?? null;
    if (!$n) return;
    run("UPDATE product_suppliers SET is_primary = 0 WHERE product_id = ?", "i", [$pid]);
    run("UPDATE product_suppliers SET is_primary = 1 WHERE product_id = ? AND supplier_id = ?", "ii", [$pid, (int)$n["supplier_id"]]);
}
/* Saves the list of suppliers of a product ($all) and sets which one is the main supplier ($main).
   Archived suppliers stay in the list so we still have the history. */
function save_links($pid, $main, $all) {
    run("UPDATE product_suppliers SET is_primary = 0 WHERE product_id = ?", "i", [$pid]);
    $keep = implode(",", array_map("intval", $all));
    run("DELETE ps FROM product_suppliers ps JOIN suppliers s ON s.supplier_id = ps.supplier_id
         WHERE ps.product_id = ? AND s.archived_at IS NULL AND ps.supplier_id NOT IN ($keep)", "i", [$pid]);
    foreach ($all as $sid)
        run("INSERT INTO product_suppliers (product_id, supplier_id, is_primary) VALUES (?, ?, 0)
             ON DUPLICATE KEY UPDATE product_id = product_id", "ii", [$pid, (int)$sid]);
    run("UPDATE product_suppliers SET is_primary = 1 WHERE product_id = ? AND supplier_id = ?", "ii", [$pid, (int)$main]);
}

/* ---------- product and category links (one product can be in many categories) ---------- */
/* Same idea as the suppliers: a product has one MAIN category (is_primary) and can have other categories too.
   Makes sure the main category is still active. If not, we pick another active category. */
function fix_primary_cat($pid) {
    $cur = rows("SELECT c.archived_at FROM product_categories pc JOIN categories c ON c.category_id = pc.category_id
                 WHERE pc.product_id = ? AND pc.is_primary = 1", "i", [$pid])[0] ?? null;
    if ($cur && $cur["archived_at"] === null) return;
    $n = rows("SELECT pc.category_id FROM product_categories pc JOIN categories c ON c.category_id = pc.category_id
               WHERE pc.product_id = ? AND c.archived_at IS NULL ORDER BY pc.category_id LIMIT 1", "i", [$pid])[0] ?? null;
    if (!$n) return;
    run("UPDATE product_categories SET is_primary = 0 WHERE product_id = ?", "i", [$pid]);
    run("UPDATE product_categories SET is_primary = 1 WHERE product_id = ? AND category_id = ?", "ii", [$pid, (int)$n["category_id"]]);
}
/* Saves the list of categories of a product ($all) and sets which one is the main category ($main).
   Archived categories stay in the list so we still have the history. */
function save_cat_links($pid, $main, $all) {
    run("UPDATE product_categories SET is_primary = 0 WHERE product_id = ?", "i", [$pid]);
    $keep = implode(",", array_map("intval", $all));
    run("DELETE pc FROM product_categories pc JOIN categories c ON c.category_id = pc.category_id
         WHERE pc.product_id = ? AND c.archived_at IS NULL AND pc.category_id NOT IN ($keep)", "i", [$pid]);
    foreach ($all as $cid)
        run("INSERT INTO product_categories (product_id, category_id, is_primary) VALUES (?, ?, 0)
             ON DUPLICATE KEY UPDATE product_id = product_id", "ii", [$pid, (int)$cid]);
    run("UPDATE product_categories SET is_primary = 1 WHERE product_id = ? AND category_id = ?", "ii", [$pid, (int)$main]);
}
function product_cat_names($pid) { // main category comes first
    return array_column(rows("SELECT c.category_name n FROM product_categories pc JOIN categories c ON c.category_id = pc.category_id
                              WHERE pc.product_id = ? ORDER BY pc.is_primary DESC, c.category_name", "i", [$pid]), "n");
}
/* The history triggers in the database only catch changes in the main tables. Changes in a link table (like a product's categories
   or an employee's roles) are saved here instead, one history row per save, and only if something really changed. */
function link_history($table, $id, $nameKey, $name, $field, $old, $new, $uid) {
    if ($old === $new) return;
    $enc = fn($v) => json_encode([$nameKey => $name, $field => $v], JSON_UNESCAPED_UNICODE);
    run("INSERT INTO record_history (table_name, record_id, change_type, old_values, new_values, changed_by) VALUES (?, ?, 'UPDATE', ?, ?, ?)",
        "sissi", [$table, $id, $enc($old), $enc($new), $uid]);
}
/* Changes the roles of an employee to the new list ($keys). We only save what actually changed in the history. */
function save_user_roles($uid, $keys) {
    global $ROLE_ID;
    $want = array_values(array_unique(array_map(fn($k) => (int)$ROLE_ID[$k], $keys)));
    $have = array_map(fn($r) => (int)$r["role_id"], rows("SELECT role_id FROM user_roles WHERE user_id = ?", "i", [$uid]));
    foreach (array_diff($have, $want) as $rid) run("DELETE FROM user_roles WHERE user_id = ? AND role_id = ?", "ii", [$uid, $rid]);
    foreach (array_diff($want, $have) as $rid) run("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)", "ii", [$uid, $rid]);
}

/* ---------- reading what the website sent us ---------- */
$action = $_GET["action"] ?? "";
$in = json_decode(file_get_contents("php://input"), true);
if (!is_array($in)) $in = [];
$str = fn($k, $max = 255) => mb_substr(trim((string)($in[$k] ?? "")), 0, $max);

/* makes a new user. The password is hashed (scrambled) first. Gives back the new user_id */
function make_user($name, $title, $roleKeys, $pw, $phone = null, $status = "Active") {
    global $conn;
    $base = strtolower(trim(preg_replace('/[^a-z0-9]+/i', ".", $name), "."));
    $base = substr($base ?: "user", 0, 30);
    $username = $base;
    $n = 1;
    while (rows("SELECT 1 FROM users WHERE username = ?", "s", [$username])) {
        $username = $base . ++$n;
    }
    $email = $username . "@stockkeeper.example";
    $hash = password_hash($pw, PASSWORD_BCRYPT);
    $title = $title === "" ? null : $title;
    $conn->begin_transaction(); // save the account and its roles together, or save nothing if something goes wrong
    run("INSERT INTO users (full_name, username, email, password_hash, job_title, phone, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)", "sssssss",
        [$name, $username, $email, $hash, $title, $phone, $status]);
    $newId = $conn->insert_id;
    save_user_roles($newId, $roleKeys);
    $conn->commit();
    return $newId;
}
function next_sku($cat) {
    $c = rows("SELECT category_name FROM categories WHERE category_id = ?", "i", [$cat])[0] ?? null;
    if (!$c) fail("Choose a valid category");
    // the first part of the SKU depends on the product's MAIN category
    $same = rows("SELECT p.sku FROM products p JOIN product_categories pc ON pc.product_id = p.product_id AND pc.is_primary = 1
                  WHERE pc.category_id = ? AND p.sku LIKE '%-%' ORDER BY p.product_id LIMIT 1", "i", [$cat])[0] ?? null;
    if ($same) {
        $pre = explode("-", $same["sku"])[0];
    } else {
        $w = array_values(array_filter(preg_split('/[^A-Za-z]+/', $c["category_name"])));
        $pre = strtoupper(count($w) > 1 ? $w[0][0] . $w[1][0] : substr($w[0] ?? "XX", 0, 2));
    }
    $top = (int)rows("SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(sku, '-', -1) AS UNSIGNED)), 0) m FROM products WHERE sku LIKE CONCAT(?, '-%')",
                     "s", [$pre])[0]["m"];
    return $pre . "-" . (max($top, $cat * 1000) + 1);
}
function other_active_admins($excludeId) {
    return (int)rows("SELECT COUNT(DISTINCT u.user_id) c FROM users u JOIN user_roles ur ON ur.user_id = u.user_id AND ur.role_id = 1
                     WHERE u.status = 'Active' AND u.user_id <> ?", "i", [$excludeId])[0]["c"];
}

/* checks for the inputs (same rules as in app.js) */
function valid_email($e) { return filter_var($e, FILTER_VALIDATE_EMAIL) !== false && strlen($e) <= 120; }
function phone_digits($p) {
    return preg_replace('/\D+/', '', (string)$p);
}
function valid_ph_phone($p) {
    // allow numbers written like 0917 123 4567 or 0917-123-4567.
    return preg_match('/^09\d{9}$/', phone_digits($p)) === 1;
}
function valid_supplier_phone($p) {
    // suppliers can use a mobile number or a landline like (02) 8365 1420.
    $digits = phone_digits($p);
    return preg_match('/^09\d{9}$/', $digits) === 1
        || preg_match('/^0[2-8]\d{7,9}$/', $digits) === 1;
}

/* ---------- archive / restore (we use this instead of deleting) ----------
   Nothing is ever deleted. Archiving fills in archived_at, restoring empties it again.
   This needs the archived_at columns we made in stockkeeper.sql. */
$ARCHIVABLE = [
    "product"  => ["products",   "product_id",  "archive", "product_name"],
    "category" => ["categories", "category_id", "archive", "category_name"],
    "supplier" => ["suppliers",  "supplier_id", "archive", "company_name"],
    "customer" => ["customers",  "customer_id", "archive", "customer_name"],
];
if (preg_match('/^(archive|restore)_([a-z]+)$/', $action, $m) && isset($ARCHIVABLE[$m[2]])) {
    $doArchive = $m[1] === "archive";
    $kind = $m[2];
    [$tbl, $pk, $perm, $nmc] = $ARCHIVABLE[$kind];
    $u = need($perm);
    $id = (int)($in["id"] ?? 0);
    if ($id < 1) fail("Choose a valid record");
    $rec = rows("SELECT archived_at, `$nmc` AS nm FROM `$tbl` WHERE `$pk` = ?", "i", [$id])[0] ?? null;
    if (!$rec) fail("Record not found", 404);
    $isArchived = $rec["archived_at"] !== null;
    if ($doArchive === $isArchived) out(["ok" => true, "archived" => $isArchived]); // already in that state, nothing to do

    if ($doArchive) {
        if ($kind === "category") {
            // we can archive a category only if every active product in it still has another active category.
            $stuck = rows("SELECT p.product_name FROM products p
                           JOIN product_categories pc ON pc.product_id = p.product_id AND pc.category_id = ?
                           WHERE p.archived_at IS NULL AND NOT EXISTS (
                               SELECT 1 FROM product_categories o JOIN categories c ON c.category_id = o.category_id
                               WHERE o.product_id = p.product_id AND o.category_id <> pc.category_id AND c.archived_at IS NULL)
                           ORDER BY p.product_name LIMIT 3", "i", [$id]);
            if ($stuck) fail("Add another category to these products first: " . implode(", ", array_column($stuck, "product_name")), 409);
        }
        if ($kind === "supplier") {
            // we can archive a supplier only if every active product it supplies still has another active supplier.
            $stuck = rows("SELECT p.product_name FROM products p
                           JOIN product_suppliers ps ON ps.product_id = p.product_id AND ps.supplier_id = ?
                           WHERE p.archived_at IS NULL AND NOT EXISTS (
                               SELECT 1 FROM product_suppliers o JOIN suppliers s ON s.supplier_id = o.supplier_id
                               WHERE o.product_id = p.product_id AND o.supplier_id <> ps.supplier_id AND s.archived_at IS NULL)
                           ORDER BY p.product_name LIMIT 3", "i", [$id]);
            if ($stuck) fail("Add another supplier to these products first: " . implode(", ", array_column($stuck, "product_name")), 409);
        }
        $conn->begin_transaction();
        run("UPDATE `$tbl` SET archived_at = NOW() WHERE `$pk` = ?", "i", [$id]);
        if ($kind === "supplier") // products that had this supplier as main will use another active supplier instead
            foreach (rows("SELECT product_id FROM product_suppliers WHERE supplier_id = ? AND is_primary = 1", "i", [$id]) as $r)
                fix_primary((int)$r["product_id"]);
        if ($kind === "category") // products that had this category as main will use another active category instead
            foreach (rows("SELECT product_id FROM product_categories WHERE category_id = ? AND is_primary = 1", "i", [$id]) as $r)
                fix_primary_cat((int)$r["product_id"]);
        $conn->commit();
    } else {
        if ($kind === "product") {
            if (!rows("SELECT 1 FROM product_categories pc JOIN categories c ON c.category_id = pc.category_id
                       WHERE pc.product_id = ? AND c.archived_at IS NULL LIMIT 1", "i", [$id]))
                fail("Restore one of this product's categories first", 409);
            if (!rows("SELECT 1 FROM product_suppliers ps JOIN suppliers s ON s.supplier_id = ps.supplier_id
                       WHERE ps.product_id = ? AND s.archived_at IS NULL LIMIT 1", "i", [$id]))
                fail("Restore one of this product's suppliers first", 409);
        }
        run("UPDATE `$tbl` SET archived_at = NULL WHERE `$pk` = ?", "i", [$id]);
        if ($kind === "product") { fix_primary($id); fix_primary_cat($id); }
    }
    audit(ucfirst($kind) . ($doArchive ? " archived: " : " restored: ") . $rec["nm"]);
    out(["ok" => true, "archived" => $doArchive]);
}

switch ($action) {

/* ====================== LOGIN / LOGOUT ====================== */
case "login_info": // anyone can call this. It only gives the store name for the login page (no accounts shown)
    $s = rows("SELECT store_name FROM settings WHERE setting_id = 1")[0] ?? ["store_name" => "Stock Keeper"];
    out(["store" => $s["store_name"]]);

case "login": // log in using username or email, plus the password
    $ident = trim((string)($in["username"] ?? ""));
    $pw = (string)($in["password"] ?? "");
    if ($ident === "" || $pw === "") fail("Enter your username or email and your password");
    $r = rows("SELECT user_id, password_hash, status FROM users WHERE username = ? OR email = ? LIMIT 1", "ss", [$ident, $ident])[0] ?? null;
    // if the account doesn't exist we still check a fake hash, so the reply takes the same time and nobody can guess which usernames are real.
    $hash = $r["password_hash"] ?? '$2y$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234';
    $okPw = password_verify($pw, $hash);
    if (!$r || !$okPw || $r["status"] !== "Active") {
        fail("Incorrect username or password", 401); // same message for any mistake so we don't give hints
    }
    session_regenerate_id(true);
    $_SESSION["uid"] = (int)$r["user_id"];
    audit("Signed in", (int)$r["user_id"]);
    out(["ok" => true]);

case "logout":
    $lu = current_user();
    if ($lu) audit("Signed out", $lu["id"]);
    $_SESSION = [];
    session_destroy();
    out(["ok" => true]);

case "deactivate_self":
    $u = need();

    // don't allow the last active admin to be deactivated
    if (
        is_admin($u) &&
        other_active_admins($u["id"]) < 1
    ) {
        fail("You cannot deactivate the last active administrator");
    }

    // turn off (deactivate) the account that is logged in right now
    run(
        "UPDATE users SET status = 'Inactive' WHERE user_id = ?",
        "i",
        [$u["id"]]
    );

    audit("Account deactivated: " . $u["name"]);

    // log the user out
    $_SESSION = [];
    session_destroy();

    out([
        "ok" => true,
        "message" => "Your account has been deactivated."
    ]);

/* ====================== LOAD ALL THE DATA ====================== */
case "bootstrap":
    $u = need();
    $data = [];

    // "arch" is true if the record is archived (hidden at first, but we can restore it)
    $data["cats"] = array_map(fn($r) => ["id" => (int)$r["category_id"], "name" => $r["category_name"], "desc" => $r["description"] ?? "", "arch" => (bool)$r["arch"], "cr" => $r["cr"], "up" => $r["up"], "ar" => $r["ar"]],
        rows("SELECT category_id, category_name, description, archived_at IS NOT NULL AS arch, " . DTA . " FROM categories ORDER BY category_id DESC"));

    $data["sup"] = array_map(fn($r) => ["id" => (int)$r["supplier_id"], "name" => $r["company_name"], "contact" => $r["contact_person"],
        "phone" => $r["phone"], "email" => $r["email"] ?? "", "addr" => $r["address"],
        "street" => $r["street"] ?? "", "brgy" => $r["barangay"] ?? "", "city" => $r["city"] ?? "", "prov" => $r["province"] ?? "",
        "arch" => (bool)$r["arch"]],
        rows("SELECT supplier_id, company_name, contact_person, phone, email, address, street, barangay, city, province, archived_at IS NOT NULL AS arch FROM suppliers ORDER BY supplier_id DESC"));

    $links = []; // each product id with its suppliers (main supplier first)
    foreach (rows("SELECT product_id, supplier_id FROM product_suppliers ORDER BY is_primary DESC, supplier_id") as $r)
        $links[(int)$r["product_id"]][] = (int)$r["supplier_id"];
    $catLinks = []; // each product id with its categories (main category first)
    foreach (rows("SELECT product_id, category_id FROM product_categories ORDER BY is_primary DESC, category_id") as $r)
        $catLinks[(int)$r["product_id"]][] = (int)$r["category_id"];
    $data["prod"] = array_map(fn($r) => ["id" => (int)$r["product_id"], "sku" => $r["sku"], "name" => $r["product_name"],
        "cat" => $catLinks[(int)$r["product_id"]][0] ?? 0, "cats" => $catLinks[(int)$r["product_id"]] ?? [], "sup" => $links[(int)$r["product_id"]][0] ?? 0, "sups" => $links[(int)$r["product_id"]] ?? [], "price" => (float)$r["unit_price"],
        "stock" => (int)$r["stock_quantity"], "min" => (int)$r["reorder_level"], "unit" => $r["unit"], "arch" => (bool)$r["arch"], "cr" => $r["cr"], "up" => $r["up"], "ar" => $r["ar"]],
        rows("SELECT product_id, sku, product_name, unit_price, stock_quantity, reorder_level, unit, archived_at IS NOT NULL AS arch, " . DTA . "
              FROM products ORDER BY product_id DESC"));

    $data["mov"] = array_map(fn($r) => ["id" => (int)$r["movement_id"], "date" => $r["d"], "pid" => (int)$r["product_id"],
        "type" => substr($r["movement_type"], -2) === "IN" ? "IN" : "OUT", "qty" => (int)$r["quantity"],
        "note" => $r["remarks"] ?: "—", "by" => $r["full_name"]],
        rows("SELECT m.movement_id, DATE_FORMAT(m.movement_date, '%Y-%m-%d %H:%i') d, m.product_id, m.movement_type, m.quantity, m.remarks, u.full_name
              FROM inventory_movements m JOIN users u ON u.user_id = m.user_id
              ORDER BY m.movement_date, m.movement_id"));

    $data["cust"] = array_map(fn($r) => ["id" => (int)$r["customer_id"], "code" => $r["customer_code"] ?? "", "name" => $r["customer_name"], "phone" => $r["phone"],
        "street" => $r["street"] ?? "", "brgy" => $r["barangay"], "city" => $r["city"], "prov" => $r["province"],
        "arch" => (bool)$r["arch"], "cr" => $r["cr"], "up" => $r["up"], "ar" => $r["ar"]],
        rows("SELECT customer_id, customer_code, customer_name, phone, street, barangay, city, province, archived_at IS NOT NULL AS arch, " . DTA . " FROM customers ORDER BY customer_id DESC"));

    $items = [];
    foreach (rows("SELECT sale_id, product_id, product_name, quantity, unit_price FROM sale_items ORDER BY sale_item_id") as $r) {
        $items[(int)$r["sale_id"]][] = ["pid" => (int)$r["product_id"], "name" => $r["product_name"], "qty" => (int)$r["quantity"], "price" => (float)$r["unit_price"]];
    }
    $data["sales"] = array_map(fn($r) => ["id" => $r["receipt_number"], "date" => $r["d"], "cust" => $r["customer_name"], "cid" => $r["customer_code"] ?? "",
        "pay" => $r["payment_method"], "by" => $r["full_name"], "items" => $items[(int)$r["sale_id"]] ?? []],
        rows("SELECT s.sale_id, s.receipt_number, DATE_FORMAT(s.sale_date, '%Y-%m-%d %H:%i') d, s.customer_name, c.customer_code, s.payment_method, u.full_name
              FROM sales s JOIN users u ON u.user_id = s.user_id
              LEFT JOIN customers c ON c.customer_id = s.customer_id
              ORDER BY s.sale_date, s.sale_id"));

    $s = rows("SELECT store_name, tax_rate, reorder_level, receipt_footer, " . DT . " FROM settings WHERE setting_id = 1")[0]
         ?? ["store_name" => "Stock Keeper", "tax_rate" => 12, "reorder_level" => 20, "receipt_footer" => ""];
    $data["set"] = ["store" => $s["store_name"], "tax" => (float)$s["tax_rate"], "reorder" => (int)$s["reorder_level"], "footer" => $s["receipt_footer"] ?? "", "cr" => $s["cr"] ?? "", "up" => $s["up"] ?? ""];

    // only send the employees and logs to the roles that are allowed to see them
    $isAdmin = is_admin($u);
    $data["emp"] = [];
    if ($isAdmin) {
        $roleMap = []; // each user id with their roles (highest role first)
        foreach (rows("SELECT user_id, role_id FROM user_roles ORDER BY role_id") as $r)
            $roleMap[(int)$r["user_id"]][] = $ROLE_KEY[(int)$r["role_id"]];
        $data["emp"] = array_map(fn($r) => ["id" => (int)$r["user_id"], "name" => $r["full_name"], "username" => $r["username"], "title" => $r["job_title"] ?? "",
            "role" => $roleMap[(int)$r["user_id"]][0] ?? "", "roles" => $roleMap[(int)$r["user_id"]] ?? [], "phone" => $r["phone"] ?: "—", "status" => $r["status"], "cr" => $r["cr"], "up" => $r["up"]],
            rows("SELECT user_id, full_name, username, job_title, phone, status, " . DT . " FROM users ORDER BY user_id DESC"));
    }
    $data["logs"] = [];
    if ($isAdmin) {
        $data["logs"] = array_map(fn($r) => ["t" => $r["d"], "u" => $r["full_name"] ?? "Deleted user",
            "r" => $r["role_id"] ? $ROLE_KEY[(int)$r["role_id"]] : "cashier", "a" => $r["description"]],
            rows("SELECT * FROM (
                    SELECT l.log_id, DATE_FORMAT(l.date_created, '%Y-%m-%d %H:%i') d, u.full_name,
                           (SELECT MIN(ur.role_id) FROM user_roles ur WHERE ur.user_id = u.user_id) AS role_id, l.description
                    FROM activity_logs l LEFT JOIN users u ON u.user_id = l.user_id
                    ORDER BY l.log_id DESC LIMIT 300) t ORDER BY log_id"));
    }
    $data["hist"] = [];
    if ($isAdmin) {
        $data["hist"] = array_map(fn($r) => ["t" => $r["d"], "tbl" => $r["table_name"], "id" => (int)$r["record_id"], "type" => $r["change_type"],
            "old" => json_decode($r["old_values"], true) ?: [], "new" => json_decode($r["new_values"], true) ?: [], "u" => $r["full_name"] ?? "System"],
            rows("SELECT h.history_id, h.table_name, h.record_id, h.change_type, DATE_FORMAT(h.changed_at, '%Y-%m-%d %H:%i') d, h.old_values, h.new_values, u.full_name
                  FROM record_history h LEFT JOIN users u ON u.user_id = h.changed_by
                  WHERE " . ($isAdmin ? "1 = 1" : "h.table_name <> 'users'") . "
                  ORDER BY h.history_id DESC LIMIT 500"));
    }
    out(["user" => $u, "data" => $data]);

/* ====================== PRODUCTS ====================== */
case "save_product":
    $u = need("manage");
    $id = (int)($in["id"] ?? 0);
    $name = $str("name", 150); $unit = $str("unit", 20);
    $cat = (int)($in["cat"] ?? 0); $sup = (int)($in["sup"] ?? 0); // $cat is the main category, $sup is the main supplier
    $moreCats = is_array($in["cats"] ?? null) ? array_map("intval", $in["cats"]) : [];
    $allCats = array_values(array_unique(array_filter(array_merge([$cat], $moreCats), fn($x) => $x > 0)));
    $more = is_array($in["sups"] ?? null) ? array_map("intval", $in["sups"]) : [];
    $all = array_values(array_unique(array_filter(array_merge([$sup], $more), fn($x) => $x > 0)));
    $price = (float)($in["price"] ?? 0); $stock = can_do($u, "stock") ? (int)($in["stock"] ?? 0) : null; $min = (int)($in["min"] ?? 0);
    if ($name === "" || $unit === "") fail("Name and unit are required");
    if ($price <= 0) fail("Price must be greater than zero");
    if ($stock < 0 || $min < 0) fail("Stock and reorder level cannot be negative");
    if ($price > 99999999.99 || $stock > 2000000000 || $min > 2000000000) fail("Price, stock or reorder level is too large");
    if ($cat < 1) fail("Choose a main category");
    if (count($allCats) > 20) fail("A product can be in at most 20 categories");
    foreach ($allCats as $cid)
        if (!rows("SELECT 1 FROM categories WHERE category_id = ? AND archived_at IS NULL", "i", [$cid])) fail("Choose active categories only");
    if ($sup < 1) fail("Choose a main supplier");
    if (count($all) > 20) fail("A product can have at most 20 suppliers");
    foreach ($all as $sid)
        if (!rows("SELECT 1 FROM suppliers WHERE supplier_id = ? AND archived_at IS NULL", "i", [$sid])) fail("Choose active suppliers only");
    $conn->begin_transaction();
    if ($id) {
        $old = rows("SELECT sku, stock_quantity FROM products WHERE product_id = ? FOR UPDATE", "i", [$id])[0] ?? null;
        if (!$old) fail("Product not found", 404);
        $sku = $old["sku"];
        if ($stock === null) $stock = (int)$old["stock_quantity"]; // managers are not allowed to change the quantity
        $oldCats = product_cat_names($id);
        run("UPDATE products SET sku=?, product_name=?, unit_price=?, stock_quantity=?, reorder_level=?, unit=?
             WHERE product_id=?", "ssdiisi", [$sku, $name, $price, $stock, $min, $unit, $id]);
        $diff = $stock - (int)$old["stock_quantity"];
        if ($diff != 0) { // if the stock was changed here, record it in the stock movements so the numbers still match
            run("INSERT INTO inventory_movements (product_id, user_id, movement_type, quantity, remarks) VALUES (?, ?, ?, ?, 'Edited in product form')",
                "iisi", [$id, $u["id"], $diff > 0 ? "ADJ_IN" : "ADJ_OUT", abs($diff)]);
        }
    } else {
        $sku = next_sku($cat);
        if ($stock === null) $stock = 0; // the starting stock is added later by the inventory staff
        run("INSERT INTO products (sku, product_name, unit_price, stock_quantity, reorder_level, unit)
             VALUES (?, ?, ?, ?, ?, ?)", "ssdiis", [$sku, $name, $price, $stock, $min, $unit]);
        $newId = $conn->insert_id;
        if ($stock > 0) {
            run("INSERT INTO inventory_movements (product_id, user_id, movement_type, quantity, remarks) VALUES (?, ?, 'IN', ?, 'Opening stock')",
                "iii", [$newId, $u["id"], $stock]);
        }
    }
    save_links($id ?: $newId, $sup, $all);
    save_cat_links($id ?: $newId, $cat, $allCats);
    if ($id) link_history("products", $id, "product_name", $name, "categories", $oldCats, product_cat_names($id), $u["id"]);
    $conn->commit();
    audit("Product " . ($id ? "updated: " : "added: ") . $name);
    out(["ok" => true, "sku" => $sku]);

/* ====================== CATEGORIES ====================== */
case "save_category":
    need("manage");
    $id = (int)($in["id"] ?? 0);
    $name = $str("name", 60);
    $desc = $str("desc", 255);
    $desc = $desc === "" ? null : $desc;
    if ($name === "") fail("Category name is required");
    if ($id) run("UPDATE categories SET category_name=?, description=? WHERE category_id=?", "ssi", [$name, $desc, $id]);
    else     run("INSERT INTO categories (category_name, description) VALUES (?, ?)", "ss", [$name, $desc]);
    audit("Category " . ($id ? "updated: " : "added: ") . $name);
    out(["ok" => true]);

/* ====================== SUPPLIERS ====================== */
case "save_supplier":
    need("manage");
    $id = (int)($in["id"] ?? 0);
    $name = $str("name", 120); $contact = $str("contact", 100);
    $street = $str("street", 120); $brgy = $str("brgy", 80); $city = $str("city", 80); $prov = $str("prov", 80);
    $phone = $str("phone", 30); $email = $str("email", 120);
    $email = $email === "" ? null : $email;
    if ($name === "" || $contact === "" || $brgy === "" || $city === "" || $prov === "" || $phone === "") fail("Company, contact, barangay, city, province and phone are required");
    // the address column keeps the whole address in one line (the history uses this too)
    $address = mb_substr(implode(", ", array_filter([$street, "Brgy. " . $brgy, $city, $prov], fn($x) => $x !== "")), 0, 255);
    $street = $street === "" ? null : $street;
    if (!valid_supplier_phone($phone)) fail("Enter a valid Philippine mobile or landline number");
    if ($email !== null && !valid_email($email)) fail("Enter a valid email address");
    if ($id) run("UPDATE suppliers SET company_name=?, contact_person=?, phone=?, email=?, address=?, street=?, barangay=?, city=?, province=? WHERE supplier_id=?",
                 "sssssssssi", [$name, $contact, $phone, $email, $address, $street, $brgy, $city, $prov, $id]);
    else     run("INSERT INTO suppliers (company_name, contact_person, phone, email, address, street, barangay, city, province) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                 "sssssssss", [$name, $contact, $phone, $email, $address, $street, $brgy, $city, $prov]);
    audit("Supplier " . ($id ? "updated: " : "added: ") . $name);
    out(["ok" => true]);

/* ====================== CUSTOMERS ====================== */
case "save_customer":
    need("customers");
    $id = (int)($in["id"] ?? 0);
    $name = $str("name", 120); $phone = $str("phone", 30);
    $street = $str("street", 150); $brgy = $str("brgy", 80); $city = $str("city", 80); $prov = $str("prov", 80);
    $street = $street === "" ? null : $street;
    if ($name === "" || $phone === "" || $brgy === "" || $city === "" || $prov === "") fail("Name, mobile number, barangay, city and province are required");
    if (!valid_ph_phone($phone)) fail("Enter a valid Philippine mobile number (09XXXXXXXXX)");
    if ($id) {
        if (!rows("SELECT 1 FROM customers WHERE customer_id = ?", "i", [$id])) fail("Customer not found", 404);
        run("UPDATE customers SET customer_name=?, phone=?, street=?, barangay=?, city=?, province=? WHERE customer_id=?",
            "ssssssi", [$name, $phone, $street, $brgy, $city, $prov, $id]);
    } else {
        run("INSERT INTO customers (customer_name, phone, street, barangay, city, province) VALUES (?, ?, ?, ?, ?, ?)",
            "ssssss", [$name, $phone, $street, $brgy, $city, $prov]);
        // the system makes the customer ID by itself, like CUST-0007 (two customers can have the same name but never the same ID)
        run("UPDATE customers SET customer_code = CONCAT('CUST-', LPAD(customer_id, 4, '0')), updated_at = updated_at WHERE customer_id = ?", "i", [$conn->insert_id]);
    }
    audit("Customer " . ($id ? "updated: " : "added: ") . $name);
    out(["ok" => true]);

/* ====================== EMPLOYEES (admin only) ====================== */
case "save_employee":
    $u = need("users");
    $id = (int)($in["id"] ?? 0);
    $name = $str("name", 100); $title = $str("title", 80);
    // an employee can have many roles: "roles" is a list (a single "role" still works too)
    $roleKeys = is_array($in["roles"] ?? null) ? array_map("strval", $in["roles"]) : [$str("role", 20)];
    $roleKeys = array_values(array_unique(array_filter($roleKeys, fn($k) => $k !== "")));
    $phone = $str("phone", 30);
    if ($phone === "" || $phone === "—") $phone = null;
    if ($name === "") fail("Full name is required");
    if ($phone !== null && !valid_ph_phone($phone)) fail("Enter a valid Philippine mobile number (09XXXXXXXXX)");
    if (!$roleKeys) fail("Choose at least one role");
    foreach ($roleKeys as $k) if (!isset($ROLE_ID[$k])) fail("Invalid role");
    $newUser = null;
    if ($id) {
        if ($id === $u["id"]) fail("Ask another administrator to edit your own record");
        if (!rows("SELECT 1 FROM users WHERE user_id = ?", "i", [$id])) fail("Employee not found", 404);
        $oldRoles = user_role_names($id);
        if (in_array("admin", user_role_keys($id), true) && !in_array("admin", $roleKeys, true) && other_active_admins($id) < 1) {
            fail("You cannot remove the Administrator role from the last active administrator");
        }
        $conn->begin_transaction();
        // we don't change the status here on purpose, set_employee_status does that
        run("UPDATE users SET full_name=?, job_title=?, phone=? WHERE user_id=?",
            "sssi", [$name, $title === "" ? null : $title, $phone, $id]);
        save_user_roles($id, $roleKeys);
        link_history("users", $id, "full_name", $name, "roles", $oldRoles, user_role_names($id), $u["id"]);
        $conn->commit();
    } else {
        $pw = (string)($in["pw"] ?? "");
        if (strlen($pw) < 6) fail("Use at least 6 characters for the password");
        $newId = make_user($name, $title, $roleKeys, $pw, $phone, "Active"); // new accounts start as Active
        $newUser = rows("SELECT username FROM users WHERE user_id = ?", "i", [$newId])[0]["username"] ?? null;
    }
    audit("Employee " . ($id ? "updated: " : "added: ") . $name);
    out(["ok" => true, "username" => $newUser]);

/* Employees are never deleted or archived. We just switch their account between
   Active and Inactive. Inactive accounts can't log in, but their history stays. */
case "set_employee_status":
    $u = need("users");
    $id = (int)($in["id"] ?? 0);
    $status = $str("status", 10);
    if ($id < 1) fail("Choose a valid employee");
    if (!in_array($status, ["Active", "Inactive"], true)) fail("Invalid status");
    if ($id === $u["id"]) fail("You cannot change the status of your own account here");
    $cur = rows("SELECT full_name, status FROM users WHERE user_id = ?", "i", [$id])[0] ?? null;
    if (!$cur) fail("Employee not found", 404);
    if ($cur["status"] === $status) out(["ok" => true, "status" => $status]); // already that status, nothing to do
    if ($status === "Inactive" && in_array("admin", user_role_keys($id), true) && other_active_admins($id) < 1)
        fail("You cannot deactivate the last active administrator");
    run("UPDATE users SET status = ? WHERE user_id = ?", "si", [$status, $id]);
    audit("Employee " . ($status === "Active" ? "activated: " : "deactivated: ") . $cur["full_name"]);
    out(["ok" => true, "status" => $status]);

/* ====================== STOCK MOVEMENTS ====================== */
case "add_movement":
    $u = need("stock");
    $pid = (int)($in["pid"] ?? 0);
    $type = ($in["type"] ?? "") === "OUT" ? "OUT" : "IN";
    $qty = (int)($in["qty"] ?? 0);
    $note = $str("note", 255);
    if ($qty <= 0 || $qty > 1000000) fail("Quantity must be between 1 and 1,000,000");
    $conn->begin_transaction();
    $p = rows("SELECT product_name, unit, stock_quantity, archived_at FROM products WHERE product_id = ? FOR UPDATE", "i", [$pid])[0] ?? null;
    if (!$p) fail("Product not found", 404);
    if ($p["archived_at"] !== null) fail("This product is archived. Restore it first", 409);
    if ($type === "OUT" && $qty > (int)$p["stock_quantity"]) fail("Only " . $p["stock_quantity"] . " on hand", 422);
    $delta = $type === "OUT" ? -$qty : $qty;
    run("UPDATE products SET stock_quantity = stock_quantity + ? WHERE product_id = ?", "ii", [$delta, $pid]);
    run("INSERT INTO inventory_movements (product_id, user_id, movement_type, quantity, remarks) VALUES (?, ?, ?, ?, ?)",
        "iisis", [$pid, $u["id"], $type, $qty, $note === "" ? null : $note]);
    $conn->commit();
    audit(($type === "OUT" ? "Stock out: " : "Stock in: ") . $qty . " × " . $p["product_name"]);
    out(["ok" => true]);

case "adjust_stock":
    $u = need("stock");
    $pid = (int)($in["pid"] ?? 0);
    $new = (int)($in["stock"] ?? -1);
    if ($new < 0 || $new > 2000000000) fail("Counted quantity must be between 0 and 2,000,000,000");
    $conn->begin_transaction();
    $p = rows("SELECT product_name, unit, stock_quantity, archived_at FROM products WHERE product_id = ? FOR UPDATE", "i", [$pid])[0] ?? null;
    if (!$p) fail("Product not found", 404);
    if ($p["archived_at"] !== null) fail("This product is archived. Restore it first", 409);
    $diff = $new - (int)$p["stock_quantity"];
    if ($diff != 0) {
        run("UPDATE products SET stock_quantity = ? WHERE product_id = ?", "ii", [$new, $pid]);
        run("INSERT INTO inventory_movements (product_id, user_id, movement_type, quantity, remarks) VALUES (?, ?, ?, ?, 'Count adjustment')",
            "iisi", [$pid, $u["id"], $diff > 0 ? "ADJ_IN" : "ADJ_OUT", abs($diff)]);
    }
    $conn->commit();
    if ($diff != 0) audit("Quantity updated: " . $p["product_name"] . " now " . $new . " " . $p["unit"]);
    out(["ok" => true]);

/* ====================== SALES ====================== */
case "add_sale":
    $u = need("sell");
    $custId = (int)($in["cust_id"] ?? 0);
    $cust = "Walk-in"; $cid = null;
    if ($custId > 0) { // a saved customer was picked in the sale form
        $c = rows("SELECT customer_name, archived_at FROM customers WHERE customer_id = ?", "i", [$custId])[0] ?? null;
        if (!$c) fail("Customer not found", 404);
        if ($c["archived_at"] !== null) fail("This customer is archived. Restore it first", 409);
        $cust = $c["customer_name"]; $cid = $custId;
    }
    $pid = (int)($in["pid"] ?? 0);
    $qty = (int)($in["qty"] ?? 0);
    $pay = $str("pay", 20);
    if (!in_array($pay, ["Cash", "GCash", "Maya", "Bank transfer", "Charge account"])) fail("Invalid payment method");
    if ($qty <= 0 || $qty > 1000000) fail("Quantity must be between 1 and 1,000,000");
    $conn->begin_transaction();
    $p = rows("SELECT unit_price, stock_quantity, archived_at FROM products WHERE product_id = ? FOR UPDATE", "i", [$pid])[0] ?? null;
    if (!$p) fail("Product not found", 404);
    if ($p["archived_at"] !== null) fail("This product is archived and cannot be sold", 409);
    if ($qty > (int)$p["stock_quantity"]) fail("Only " . $p["stock_quantity"] . " in stock", 422);
    rows("SELECT GET_LOCK('sk_receipt', 5) g"); // so two sales at the same time can't get the same receipt number
    $n = (int)rows("SELECT COALESCE(MAX(CAST(SUBSTRING(receipt_number, 3) AS UNSIGNED)), 1000) + 1 AS n FROM sales")[0]["n"];
    $receipt = "S-" . $n;
    run("INSERT INTO sales (receipt_number, user_id, customer_id, customer_name, payment_method, total_amount) VALUES (?, ?, ?, ?, ?, 0)",
        "siiss", [$receipt, $u["id"], $cid, $cust, $pay]);
    $saleId = $conn->insert_id;
    run("INSERT INTO sale_items (sale_id, product_id, quantity, unit_price) VALUES (?, ?, ?, ?)",
        "iiid", [$saleId, $pid, $qty, $p["unit_price"]]);
    run("UPDATE sales SET total_amount = (SELECT SUM(subtotal) FROM sale_items WHERE sale_id = ?) WHERE sale_id = ?", "ii", [$saleId, $saleId]);
    run("UPDATE products SET stock_quantity = stock_quantity - ? WHERE product_id = ?", "ii", [$qty, $pid]);
    run("INSERT INTO inventory_movements (product_id, user_id, movement_type, quantity, remarks) VALUES (?, ?, 'OUT', ?, ?)",
        "iiis", [$pid, $u["id"], $qty, "Sale " . $receipt]);
    $conn->commit();
    rows("SELECT RELEASE_LOCK('sk_receipt') r");
    audit("Sale $receipt saved");
    out(["receipt" => $receipt]);

/* ====================== MY ACCOUNT (any logged-in user) ====================== */
case "update_profile":
    $u = need();
    $name = $str("name", 100); $title = $str("title", 80);
    $email = $str("email", 120); $phone = $str("phone", 30);
    if ($name === "") fail("Full name is required");
    if (!valid_email($email)) fail("Enter a valid email address");
    if (!valid_ph_phone($phone)) fail("Enter a valid Philippine mobile number (09XXXXXXXXX)");
    run("UPDATE users SET full_name=?, job_title=?, email=?, phone=? WHERE user_id=?", "ssssi",
        [$name, $title === "" ? null : $title, $email, $phone, $u["id"]]);
    audit("Profile updated");
    out(["ok" => true]);

case "change_password":
    $u = need();
    $cur = (string)($in["current"] ?? "");
    $new = (string)($in["password"] ?? "");
    if (strlen($new) < 6) fail("Use at least 6 characters for the new password");
    $r = rows("SELECT password_hash FROM users WHERE user_id = ?", "i", [$u["id"]])[0] ?? null;
    if (!$r || !password_verify($cur, $r["password_hash"])) fail("Current password is incorrect", 403); // we use 403 and not 401 so the app doesn't log the user out
    run("UPDATE users SET password_hash = ? WHERE user_id = ?", "si", [password_hash($new, PASSWORD_BCRYPT), $u["id"]]);
    audit("Password updated");
    session_regenerate_id(true);
    out(["ok" => true]);

/* ====================== SETTINGS ====================== */
case "save_settings":
    need("users");
    $store = $str("store", 100);
    $tax = (float)($in["tax"] ?? -1);
    $reorder = (int)($in["reorder"] ?? -1);
    $footer = $str("footer", 255);
    if ($store === "") fail("Store name is required");
    if ($tax < 0 || $tax > 100) fail("Tax rate must be between 0 and 100");
    if ($reorder < 0) fail("Reorder level cannot be negative");
    run("INSERT INTO settings (setting_id, store_name, tax_rate, reorder_level, receipt_footer) VALUES (1, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE store_name = VALUES(store_name), tax_rate = VALUES(tax_rate),
         reorder_level = VALUES(reorder_level), receipt_footer = VALUES(receipt_footer)",
        "sdis", [$store, $tax, $reorder, $footer === "" ? null : $footer]);
    audit("Settings saved");
    out(["ok" => true]);

default:
    fail("Unknown action", 404);
}