<?php
// api.php - the single backend endpoint for Stock Keeper.
// The frontend calls:  api.php?action=<name>   (JSON in, JSON out)

session_set_cookie_params(["httponly" => true, "samesite" => "Lax"]);
session_start();
header("Content-Type: application/json; charset=utf-8");
mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT); // DB errors become exceptions

/* ---------- small helpers ---------- */
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
        if ($ex->getCode() == 1062) fail("That value already exists (duplicate SKU, name or email)", 409);
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

/* created / updated / archived dates sent with every record list (system rule: track dates) */
const DT  = "DATE_FORMAT(created_at, '%Y-%m-%d %H:%i') cr, DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i') up";
const DTA = DT . ", DATE_FORMAT(archived_at, '%Y-%m-%d %H:%i') ar";

/* ---------- roles and permissions (same matrix as app.js) ---------- */
$ROLE_KEY = [1 => "admin", 2 => "manager", 3 => "inventory", 4 => "cashier"];
$ROLE_ID  = array_flip($ROLE_KEY);
$CAN = [
    "manage" => ["admin", "manager"],
    "users"  => ["admin"],
    "stock"  => ["admin", "inventory"],
    "sell"   => ["admin", "cashier"],
];

function current_user() {
    global $ROLE_KEY;
    static $u = false;
    if ($u !== false) return $u;
    $u = null;
    if (!empty($_SESSION["uid"])) {
        $r = rows("SELECT user_id, full_name, username, email, phone, job_title, role_id, status, " . DT . " FROM users WHERE user_id = ?", "i", [$_SESSION["uid"]])[0] ?? null;
        if ($r && $r["status"] === "Active") {
            $u = [
                "id"       => (int)$r["user_id"],
                "name"     => $r["full_name"],
                "username" => $r["username"],
                "email"    => $r["email"],
                "phone"    => $r["phone"] ?? "",
                "title"    => $r["job_title"] ?? "",
                "role"     => $ROLE_KEY[(int)$r["role_id"]],
                "cr"       => $r["cr"],
                "up"       => $r["up"],
            ];
        }
    }
    return $u;
}
function need($perm = null) {
    global $CAN;
    $u = current_user();
    if (!$u) fail("Please sign in", 401);
    if ($perm && !in_array($u["role"], $CAN[$perm])) fail("Permission denied: your role cannot do this", 403);
    global $conn;
    $conn->query("SET @app_user_id = " . (int)$u["id"]); // lets the history triggers record who made each change
    return $u;
}

/* ---------- input ---------- */
$action = $_GET["action"] ?? "";
$in = json_decode(file_get_contents("php://input"), true);
if (!is_array($in)) $in = [];
$str = fn($k, $max = 255) => mb_substr(trim((string)($in[$k] ?? "")), 0, $max);

/* creates a user row with a hashed password; returns the new user_id */
function make_user($name, $title, $roleKey, $pw, $phone = null, $status = "Active") {
    global $conn, $ROLE_ID;
    $base = strtolower(trim(preg_replace('/[^a-z0-9]+/i', ".", $name), "."));
    $base = substr($base ?: "user", 0, 30);
    $username = $base;
    $n = 1;
    while (rows("SELECT 1 FROM users WHERE username = ?", "s", [$username])) {
        $username = $base . ++$n;
    }
    $email = $username . "@stockkeeper.example";
    $hash = password_hash($pw, PASSWORD_BCRYPT);
    $rid = $ROLE_ID[$roleKey];
    $title = $title === "" ? null : $title;
    run("INSERT INTO users (full_name, username, email, password_hash, role_id, job_title, phone, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)", "ssssisss",
        [$name, $username, $email, $hash, $rid, $title, $phone, $status]);
    return $conn->insert_id;
}
function next_sku($cat) {
    $c = rows("SELECT category_name FROM categories WHERE category_id = ?", "i", [$cat])[0] ?? null;
    if (!$c) fail("Choose a valid category");
    $same = rows("SELECT sku FROM products WHERE category_id = ? AND sku LIKE '%-%' ORDER BY product_id LIMIT 1", "i", [$cat])[0] ?? null;
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
    return (int)rows("SELECT COUNT(*) c FROM users WHERE role_id = 1 AND status = 'Active' AND user_id <> ?", "i", [$excludeId])[0]["c"];
}

/* strict validators (same rules as app.js) */
function valid_email($e) { return filter_var($e, FILTER_VALIDATE_EMAIL) !== false && strlen($e) <= 120; }
function valid_ph_phone($p) { return preg_match('/^09\d{9}$/', $p) === 1; } // 09XXXXXXXXX, 11 digits

/* ---------- archive / restore (replaces permanent delete) ----------
   Records are never removed. Archiving sets archived_at; restoring clears it.
   Requires the archived_at columns defined in stockkeeper.sql. */
$ARCHIVABLE = [
    "product"  => ["products",   "product_id",  "manage"],
    "category" => ["categories", "category_id", "manage"],
    "supplier" => ["suppliers",  "supplier_id", "manage"],
];
if (preg_match('/^(archive|restore)_([a-z]+)$/', $action, $m) && isset($ARCHIVABLE[$m[2]])) {
    $doArchive = $m[1] === "archive";
    $kind = $m[2];
    [$tbl, $pk, $perm] = $ARCHIVABLE[$kind];
    $u = need($perm);
    $id = (int)($in["id"] ?? 0);
    if ($id < 1) fail("Choose a valid record");
    $rec = rows("SELECT archived_at FROM `$tbl` WHERE `$pk` = ?", "i", [$id])[0] ?? null;
    if (!$rec) fail("Record not found", 404);
    $isArchived = $rec["archived_at"] !== null;
    if ($doArchive === $isArchived) out(["ok" => true, "archived" => $isArchived]); // nothing to change

    if ($doArchive) {
        if ($kind === "category" && (int)rows("SELECT COUNT(*) c FROM products WHERE category_id = ? AND archived_at IS NULL", "i", [$id])[0]["c"] > 0)
            fail("Archive or move the active products in this category first", 409);
        if ($kind === "supplier" && (int)rows("SELECT COUNT(*) c FROM products WHERE supplier_id = ? AND archived_at IS NULL", "i", [$id])[0]["c"] > 0)
            fail("Archive or move the active products from this supplier first", 409);
        run("UPDATE `$tbl` SET archived_at = NOW() WHERE `$pk` = ?", "i", [$id]);
    } else {
        if ($kind === "product") {
            $p = rows("SELECT c.archived_at ca, s.archived_at sa FROM products p
                       JOIN categories c ON c.category_id = p.category_id
                       JOIN suppliers s ON s.supplier_id = p.supplier_id WHERE p.product_id = ?", "i", [$id])[0] ?? null;
            if ($p && $p["ca"] !== null) fail("Restore this product's category first", 409);
            if ($p && $p["sa"] !== null) fail("Restore this product's supplier first", 409);
        }
        run("UPDATE `$tbl` SET archived_at = NULL WHERE `$pk` = ?", "i", [$id]);
    }
    out(["ok" => true, "archived" => $doArchive]);
}

switch ($action) {

/* ====================== AUTH ====================== */
case "login_info": // public: only the store name for the login screen (no list of accounts)
    $s = rows("SELECT store_name FROM settings WHERE setting_id = 1")[0] ?? ["store_name" => "Stock Keeper"];
    out(["store" => $s["store_name"]]);

case "login": // sign in with username OR email, plus password
    $ident = trim((string)($in["username"] ?? ""));
    $pw = (string)($in["password"] ?? "");
    if ($ident === "" || $pw === "") fail("Enter your username or email and your password");
    $r = rows("SELECT user_id, password_hash, status FROM users WHERE username = ? OR email = ? LIMIT 1", "ss", [$ident, $ident])[0] ?? null;
    // Verify against a dummy hash when the account does not exist, so response time does not reveal valid usernames.
    $hash = $r["password_hash"] ?? '$2y$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234';
    $okPw = password_verify($pw, $hash);
    if (!$r || !$okPw || $r["status"] !== "Active") {
        fail("Incorrect username or password", 401); // same message for every failure
    }
    session_regenerate_id(true);
    $_SESSION["uid"] = (int)$r["user_id"];
    out(["ok" => true]);

case "logout":
    $_SESSION = [];
    session_destroy();
    out(["ok" => true]);

case "deactivate_self":
    $u = need();

    // Prevent the last active administrator from deactivating
    if (
        $u["role"] === "admin" &&
        other_active_admins($u["id"]) < 1
    ) {
        fail("You cannot deactivate the last active administrator");
    }

    // Deactivate the currently signed-in account
    run(
        "UPDATE users SET status = 'Inactive' WHERE user_id = ?",
        "i",
        [$u["id"]]
    );

    // Log the user out
    $_SESSION = [];
    session_destroy();

    out([
        "ok" => true,
        "message" => "Your account has been deactivated."
    ]);

case "register": // public sign-up. Administrators cannot be created this way.
    $name = $str("name", 100);
    $title = $str("title", 80);
    $role = $str("role", 20);
    $pw = (string)($in["password"] ?? "");
    if ($name === "") fail("Full name is required");
    if (strlen($pw) < 6) fail("Use at least 6 characters for the password");
    if (!isset($ROLE_ID[$role]) || in_array($role, ["admin", "manager"])) fail("Choose a valid role. Administrator and Manager accounts are created by an administrator.");
    $newId = make_user($name, $title, $role, $pw);
    $uname = rows("SELECT username FROM users WHERE user_id = ?", "i", [$newId])[0]["username"] ?? "";
    out(["id" => $newId, "username" => $uname]);

/* ====================== LOAD EVERYTHING ====================== */
case "bootstrap":
    $u = need();
    $data = [];

    // "arch" = true when the record is archived (hidden by default, restorable)
    $data["cats"] = array_map(fn($r) => ["id" => (int)$r["category_id"], "name" => $r["category_name"], "desc" => $r["description"] ?? "", "arch" => (bool)$r["arch"], "cr" => $r["cr"], "up" => $r["up"], "ar" => $r["ar"]],
        rows("SELECT category_id, category_name, description, archived_at IS NOT NULL AS arch, " . DTA . " FROM categories ORDER BY category_id DESC"));

    $data["sup"] = array_map(fn($r) => ["id" => (int)$r["supplier_id"], "name" => $r["company_name"], "contact" => $r["contact_person"],
        "phone" => $r["phone"], "email" => $r["email"] ?? "", "city" => $r["address"], "arch" => (bool)$r["arch"]],
        rows("SELECT supplier_id, company_name, contact_person, phone, email, address, archived_at IS NOT NULL AS arch FROM suppliers ORDER BY supplier_id DESC"));

    $data["prod"] = array_map(fn($r) => ["id" => (int)$r["product_id"], "sku" => $r["sku"], "name" => $r["product_name"],
        "cat" => (int)$r["category_id"], "sup" => (int)$r["supplier_id"], "price" => (float)$r["unit_price"],
        "stock" => (int)$r["stock_quantity"], "min" => (int)$r["reorder_level"], "unit" => $r["unit"], "arch" => (bool)$r["arch"], "cr" => $r["cr"], "up" => $r["up"], "ar" => $r["ar"]],
        rows("SELECT product_id, sku, product_name, category_id, supplier_id, unit_price, stock_quantity, reorder_level, unit, archived_at IS NOT NULL AS arch, " . DTA . "
              FROM products ORDER BY product_id DESC"));

    $data["mov"] = array_map(fn($r) => ["id" => (int)$r["movement_id"], "date" => $r["d"], "pid" => (int)$r["product_id"],
        "type" => substr($r["movement_type"], -2) === "IN" ? "IN" : "OUT", "qty" => (int)$r["quantity"],
        "note" => $r["remarks"] ?: "—", "by" => $r["full_name"]],
        rows("SELECT m.movement_id, DATE_FORMAT(m.movement_date, '%Y-%m-%d %H:%i') d, m.product_id, m.movement_type, m.quantity, m.remarks, u.full_name
              FROM inventory_movements m JOIN users u ON u.user_id = m.user_id
              ORDER BY m.movement_date, m.movement_id"));

    $data["cust"] = array_map(fn($r) => ["id" => (int)$r["customer_id"], "name" => $r["customer_name"], "phone" => $r["phone"],
        "street" => $r["street"] ?? "", "brgy" => $r["barangay"], "city" => $r["city"], "prov" => $r["province"],
        "arch" => (bool)$r["arch"], "cr" => $r["cr"], "up" => $r["up"], "ar" => $r["ar"]],
        rows("SELECT customer_id, customer_name, phone, street, barangay, city, province, archived_at IS NOT NULL AS arch, " . DTA . " FROM customers ORDER BY customer_id DESC"));

    $items = [];
    foreach (rows("SELECT sale_id, product_id, product_name, quantity, unit_price FROM sale_items ORDER BY sale_item_id") as $r) {
        $items[(int)$r["sale_id"]][] = ["pid" => (int)$r["product_id"], "name" => $r["product_name"], "qty" => (int)$r["quantity"], "price" => (float)$r["unit_price"]];
    }
    $data["sales"] = array_map(fn($r) => ["id" => $r["receipt_number"], "date" => $r["d"], "cust" => $r["customer_name"],
        "pay" => $r["payment_method"], "by" => $r["full_name"], "items" => $items[(int)$r["sale_id"]] ?? []],
        rows("SELECT s.sale_id, s.receipt_number, DATE_FORMAT(s.sale_date, '%Y-%m-%d %H:%i') d, s.customer_name, s.payment_method, u.full_name
              FROM sales s JOIN users u ON u.user_id = s.user_id
              ORDER BY s.sale_date, s.sale_id"));

    $s = rows("SELECT store_name, tax_rate, reorder_level, receipt_footer, " . DT . " FROM settings WHERE setting_id = 1")[0]
         ?? ["store_name" => "Stock Keeper", "tax_rate" => 12, "reorder_level" => 20, "receipt_footer" => ""];
    $data["set"] = ["store" => $s["store_name"], "tax" => (float)$s["tax_rate"], "reorder" => (int)$s["reorder_level"], "footer" => $s["receipt_footer"] ?? "", "cr" => $s["cr"] ?? "", "up" => $s["up"] ?? ""];

    // employees and logs are only sent to roles that can see them
    $data["emp"] = [];
    if ($u["role"] === "admin") {
        $data["emp"] = array_map(fn($r) => ["id" => (int)$r["user_id"], "name" => $r["full_name"], "title" => $r["job_title"] ?? "",
            "role" => $ROLE_KEY[(int)$r["role_id"]], "phone" => $r["phone"] ?: "—", "status" => $r["status"], "cr" => $r["cr"], "up" => $r["up"]],
            rows("SELECT user_id, full_name, job_title, role_id, phone, status, " . DT . " FROM users ORDER BY user_id DESC"));
    }
    $data["logs"] = [];
    if (in_array($u["role"], ["admin", "manager"])) {
        $data["logs"] = array_map(fn($r) => ["t" => $r["d"], "u" => $r["full_name"] ?? "Deleted user",
            "r" => $r["role_id"] ? $ROLE_KEY[(int)$r["role_id"]] : "cashier", "a" => $r["description"]],
            rows("SELECT * FROM (
                    SELECT l.log_id, DATE_FORMAT(l.date_created, '%Y-%m-%d %H:%i') d, u.full_name, u.role_id, l.description
                    FROM activity_logs l LEFT JOIN users u ON u.user_id = l.user_id
                    ORDER BY l.log_id DESC LIMIT 300) t ORDER BY log_id"));
    }
    $data["hist"] = [];
    if (in_array($u["role"], ["admin", "manager"])) {
        $data["hist"] = array_map(fn($r) => ["t" => $r["d"], "tbl" => $r["table_name"], "id" => (int)$r["record_id"], "type" => $r["change_type"],
            "old" => json_decode($r["old_values"], true) ?: [], "new" => json_decode($r["new_values"], true) ?: [], "u" => $r["full_name"] ?? "System"],
            rows("SELECT h.history_id, h.table_name, h.record_id, h.change_type, DATE_FORMAT(h.changed_at, '%Y-%m-%d %H:%i') d, h.old_values, h.new_values, u.full_name
                  FROM record_history h LEFT JOIN users u ON u.user_id = h.changed_by
                  WHERE " . ($u["role"] === "admin" ? "1 = 1" : "h.table_name <> 'users'") . "
                  ORDER BY h.history_id DESC LIMIT 500"));
    }
    out(["user" => $u, "data" => $data]);

/* ====================== PRODUCTS ====================== */
case "save_product":
    $u = need("manage");
    $id = (int)($in["id"] ?? 0);
    $name = $str("name", 150); $unit = $str("unit", 20);
    $cat = (int)($in["cat"] ?? 0); $sup = (int)($in["sup"] ?? 0);
    $price = (float)($in["price"] ?? 0); $stock = in_array($u["role"], $CAN["stock"]) ? (int)($in["stock"] ?? 0) : null; $min = (int)($in["min"] ?? 0);
    if ($name === "" || $unit === "") fail("Name and unit are required");
    if ($price <= 0) fail("Price must be greater than zero");
    if ($stock < 0 || $min < 0) fail("Stock and reorder level cannot be negative");
    if (!rows("SELECT 1 FROM categories WHERE category_id = ? AND archived_at IS NULL", "i", [$cat])) fail("Choose an active category");
    if (!rows("SELECT 1 FROM suppliers WHERE supplier_id = ? AND archived_at IS NULL", "i", [$sup])) fail("Choose an active supplier");
    $conn->begin_transaction();
    if ($id) {
        $old = rows("SELECT sku, stock_quantity FROM products WHERE product_id = ? FOR UPDATE", "i", [$id])[0] ?? null;
        if (!$old) fail("Product not found", 404);
        $sku = $old["sku"];
        if ($stock === null) $stock = (int)$old["stock_quantity"]; // managers cannot change quantities
        run("UPDATE products SET sku=?, product_name=?, category_id=?, supplier_id=?, unit_price=?, stock_quantity=?, reorder_level=?, unit=?
             WHERE product_id=?", "ssiidiisi", [$sku, $name, $cat, $sup, $price, $stock, $min, $unit, $id]);
        $diff = $stock - (int)$old["stock_quantity"];
        if ($diff != 0) { // keep the stock ledger honest when stock is edited here
            run("INSERT INTO inventory_movements (product_id, user_id, movement_type, quantity, remarks) VALUES (?, ?, ?, ?, 'Edited in product form')",
                "iisi", [$id, $u["id"], $diff > 0 ? "ADJ_IN" : "ADJ_OUT", abs($diff)]);
        }
    } else {
        $sku = next_sku($cat);
        if ($stock === null) $stock = 0; // opening stock is received by inventory staff
        run("INSERT INTO products (sku, product_name, category_id, supplier_id, unit_price, stock_quantity, reorder_level, unit)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)", "ssiidiis", [$sku, $name, $cat, $sup, $price, $stock, $min, $unit]);
        $newId = $conn->insert_id;
        if ($stock > 0) {
            run("INSERT INTO inventory_movements (product_id, user_id, movement_type, quantity, remarks) VALUES (?, ?, 'IN', ?, 'Opening stock')",
                "iii", [$newId, $u["id"], $stock]);
        }
    }
    $conn->commit();
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
    out(["ok" => true]);

/* ====================== SUPPLIERS ====================== */
case "save_supplier":
    need("manage");
    $id = (int)($in["id"] ?? 0);
    $name = $str("name", 120); $contact = $str("contact", 100);
    $street = $str("street", 120); $brgy = $str("brgy", 80); $city = $str("city", 80); $prov = $str("prov", 80);
    $phone = $str("phone", 30); $email = $str("email", 120);
    $email = $email === "" ? null : $email;
    $street = $street === "" ? null : $street;
    if ($name === "" || $contact === "" || $brgy === "" || $city === "" || $prov === "" || $phone === "") fail("Company, contact, barangay, city, province and phone are required");
    if (!valid_ph_phone($phone)) fail("Enter a valid Philippine mobile number (09XXXXXXXXX)");
    if ($email !== null && !valid_email($email)) fail("Enter a valid email address");
    if ($id) run("UPDATE suppliers SET company_name=?, contact_person=?, phone=?, email=?, street=?, barangay=?, city=?, province=? WHERE supplier_id=?",
                 "ssssssssi", [$name, $contact, $phone, $email, $street, $brgy, $city, $prov, $id]);
    else     run("INSERT INTO suppliers (company_name, contact_person, phone, email, street, barangay, city, province) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                 "ssssssss", [$name, $contact, $phone, $email, $street, $brgy, $city, $prov]);
    out(["ok" => true]);

/* ====================== CUSTOMERS ====================== */
case "save_customer":
    need("customers");
    $id = (int)($in["id"] ?? 0);
    $name = $str("name", 120); $phone = $str("phone", 30); $street = $str("street", 120);
    $brgy = $str("brgy", 80); $city = $str("city", 80); $prov = $str("prov", 80);
    $street = $street === "" ? null : $street;
    if ($name === "" || $phone === "" || $brgy === "" || $city === "" || $prov === "") fail("Name, phone, barangay, city and province are required");
    if (!valid_ph_phone($phone)) fail("Enter a valid Philippine mobile number (09XXXXXXXXX)");
    if ($id) {
        if (!rows("SELECT 1 FROM customers WHERE customer_id = ?", "i", [$id])) fail("Customer not found", 404);
        run("UPDATE customers SET customer_name=?, phone=?, street=?, barangay=?, city=?, province=? WHERE customer_id=?",
            "ssssssi", [$name, $phone, $street, $brgy, $city, $prov, $id]);
    } else {
        run("INSERT INTO customers (customer_name, phone, street, barangay, city, province) VALUES (?, ?, ?, ?, ?, ?)",
            "ssssss", [$name, $phone, $street, $brgy, $city, $prov]);
    }
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
    }
    out(["ok" => true]);

/* ====================== EMPLOYEES (administrator only) ====================== */
case "save_employee":
    $u = need("users");
    $id = (int)($in["id"] ?? 0);
    $name = $str("name", 100); $title = $str("title", 80); $role = $str("role", 20);
    $phone = $str("phone", 30);
    if ($phone === "" || $phone === "—") $phone = null;
    if ($name === "") fail("Full name is required");
    if ($phone !== null && !valid_ph_phone($phone)) fail("Enter a valid Philippine mobile number (09XXXXXXXXX)");
    if (!isset($ROLE_ID[$role])) fail("Invalid role");
    if ($id) {
        if ($id === $u["id"]) fail("Ask another administrator to edit your own record");
        $cur = rows("SELECT role_id FROM users WHERE user_id = ?", "i", [$id])[0] ?? null;
        if (!$cur) fail("Employee not found", 404);
        if ((int)$cur["role_id"] === 1 && $role !== "admin" && other_active_admins($id) < 1) {
            fail("You cannot demote the last active administrator");
        }
        // status is intentionally not editable here: use set_employee_status
        run("UPDATE users SET full_name=?, job_title=?, role_id=?, phone=? WHERE user_id=?",
            "ssisi", [$name, $title === "" ? null : $title, $ROLE_ID[$role], $phone, $id]);
    } else {
        $pw = (string)($in["pw"] ?? "");
        if (strlen($pw) < 6) fail("Use at least 6 characters for the password");
        make_user($name, $title, $role, $pw, $phone, "Active"); // new accounts start Active
    }
    out(["ok" => true]);

/* Employees are never deleted or archived. Their account is switched between
   Active and Inactive; Inactive accounts cannot sign in, history is preserved. */
case "set_employee_status":
    $u = need("users");
    $id = (int)($in["id"] ?? 0);
    $status = $str("status", 10);
    if ($id < 1) fail("Choose a valid employee");
    if (!in_array($status, ["Active", "Inactive"], true)) fail("Invalid status");
    if ($id === $u["id"]) fail("You cannot change the status of your own account here");
    $cur = rows("SELECT role_id, status FROM users WHERE user_id = ?", "i", [$id])[0] ?? null;
    if (!$cur) fail("Employee not found", 404);
    if ($cur["status"] === $status) out(["ok" => true, "status" => $status]); // nothing to change
    if ($status === "Inactive" && (int)$cur["role_id"] === 1 && other_active_admins($id) < 1)
        fail("You cannot deactivate the last active administrator");
    run("UPDATE users SET status = ? WHERE user_id = ?", "si", [$status, $id]);
    out(["ok" => true, "status" => $status]);

/* ====================== STOCK MOVEMENTS ====================== */
case "add_movement":
    $u = need("stock");
    $pid = (int)($in["pid"] ?? 0);
    $type = ($in["type"] ?? "") === "OUT" ? "OUT" : "IN";
    $qty = (int)($in["qty"] ?? 0);
    $note = $str("note", 255);
    if ($qty <= 0) fail("Quantity must be at least 1");
    $conn->begin_transaction();
    $p = rows("SELECT stock_quantity, archived_at FROM products WHERE product_id = ? FOR UPDATE", "i", [$pid])[0] ?? null;
    if (!$p) fail("Product not found", 404);
    if ($p["archived_at"] !== null) fail("This product is archived. Restore it first", 409);
    if ($type === "OUT" && $qty > (int)$p["stock_quantity"]) fail("Only " . $p["stock_quantity"] . " on hand", 422);
    $delta = $type === "OUT" ? -$qty : $qty;
    run("UPDATE products SET stock_quantity = stock_quantity + ? WHERE product_id = ?", "ii", [$delta, $pid]);
    run("INSERT INTO inventory_movements (product_id, user_id, movement_type, quantity, remarks) VALUES (?, ?, ?, ?, ?)",
        "iisis", [$pid, $u["id"], $type, $qty, $note === "" ? null : $note]);
    $conn->commit();
    out(["ok" => true]);

case "adjust_stock":
    $u = need("stock");
    $pid = (int)($in["pid"] ?? 0);
    $new = (int)($in["stock"] ?? -1);
    if ($new < 0) fail("Counted quantity cannot be negative");
    $conn->begin_transaction();
    $p = rows("SELECT stock_quantity, archived_at FROM products WHERE product_id = ? FOR UPDATE", "i", [$pid])[0] ?? null;
    if (!$p) fail("Product not found", 404);
    if ($p["archived_at"] !== null) fail("This product is archived. Restore it first", 409);
    $diff = $new - (int)$p["stock_quantity"];
    if ($diff != 0) {
        run("UPDATE products SET stock_quantity = ? WHERE product_id = ?", "ii", [$new, $pid]);
        run("INSERT INTO inventory_movements (product_id, user_id, movement_type, quantity, remarks) VALUES (?, ?, ?, ?, 'Count adjustment')",
            "iisi", [$pid, $u["id"], $diff > 0 ? "ADJ_IN" : "ADJ_OUT", abs($diff)]);
    }
    $conn->commit();
    out(["ok" => true]);

/* ====================== SALES ====================== */
case "add_sale":
    $u = need("sell");
    $cust = $str("cust", 120) ?: "Walk-in";
    $pid = (int)($in["pid"] ?? 0);
    $qty = (int)($in["qty"] ?? 0);
    $pay = $str("pay", 20);
    if (!in_array($pay, ["Cash", "GCash", "Maya", "Bank transfer", "Charge account"])) fail("Invalid payment method");
    if ($qty <= 0) fail("Quantity must be at least 1");
    $conn->begin_transaction();
    $p = rows("SELECT unit_price, stock_quantity, archived_at FROM products WHERE product_id = ? FOR UPDATE", "i", [$pid])[0] ?? null;
    if (!$p) fail("Product not found", 404);
    if ($p["archived_at"] !== null) fail("This product is archived and cannot be sold", 409);
    if ($qty > (int)$p["stock_quantity"]) fail("Only " . $p["stock_quantity"] . " in stock", 422);
    $n = (int)rows("SELECT COALESCE(MAX(CAST(SUBSTRING(receipt_number, 3) AS UNSIGNED)), 1000) + 1 AS n FROM sales")[0]["n"];
    $receipt = "S-" . $n;
    run("INSERT INTO sales (receipt_number, user_id, customer_name, payment_method, total_amount) VALUES (?, ?, ?, ?, 0)",
        "siss", [$receipt, $u["id"], $cust, $pay]);
    $saleId = $conn->insert_id;
    run("INSERT INTO sale_items (sale_id, product_id, quantity, unit_price) VALUES (?, ?, ?, ?)",
        "iiid", [$saleId, $pid, $qty, $p["unit_price"]]);
    run("UPDATE sales SET total_amount = (SELECT SUM(subtotal) FROM sale_items WHERE sale_id = ?) WHERE sale_id = ?", "ii", [$saleId, $saleId]);
    run("UPDATE products SET stock_quantity = stock_quantity - ? WHERE product_id = ?", "ii", [$qty, $pid]);
    run("INSERT INTO inventory_movements (product_id, user_id, movement_type, quantity, remarks) VALUES (?, ?, 'OUT', ?, ?)",
        "iiis", [$pid, $u["id"], $qty, "Sale " . $receipt]);
    $conn->commit();
    out(["receipt" => $receipt]);

/* ====================== MY ACCOUNT (any signed-in user) ====================== */
case "update_profile":
    $u = need();
    $name = $str("name", 100); $title = $str("title", 80);
    $email = $str("email", 120); $phone = $str("phone", 30);
    if ($name === "") fail("Full name is required");
    if (!valid_email($email)) fail("Enter a valid email address");
    if (!valid_ph_phone($phone)) fail("Enter a valid Philippine mobile number (09XXXXXXXXX)");
    run("UPDATE users SET full_name=?, job_title=?, email=?, phone=? WHERE user_id=?", "ssssi",
        [$name, $title === "" ? null : $title, $email, $phone, $u["id"]]);
    out(["ok" => true]);

case "change_password":
    $u = need();
    $cur = (string)($in["current"] ?? "");
    $new = (string)($in["password"] ?? "");
    if (strlen($new) < 6) fail("Use at least 6 characters for the new password");
    $r = rows("SELECT password_hash FROM users WHERE user_id = ?", "i", [$u["id"]])[0] ?? null;
    if (!$r || !password_verify($cur, $r["password_hash"])) fail("Current password is incorrect", 403); // 403, not 401, so the app does not sign the user out
    run("UPDATE users SET password_hash = ? WHERE user_id = ?", "si", [password_hash($new, PASSWORD_BCRYPT), $u["id"]]);
    session_regenerate_id(true);
    out(["ok" => true]);

/* ====================== SETTINGS & LOGS ====================== */
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
    out(["ok" => true]);

case "log":
    $u = need();
    $text = $str("text", 500);
    if ($text === "") out(["ok" => true]);
    if (preg_match('/^Signed in/', $text))            $code = "LOGIN";
    elseif (preg_match('/^Signed out/', $text))       $code = "LOGOUT";
    elseif (preg_match('/^Sale/', $text))             $code = "SALE_CREATE";
    elseif (preg_match('/^(Stock|Quantity)/', $text)) $code = "STOCK";
    elseif (preg_match('/archived|restored/i', $text)) $code = "UPDATE"; // reuse an existing code so the activity_logs column accepts it
    elseif (preg_match('/deleted/i', $text))          $code = "DELETE";
    elseif (preg_match('/added/i', $text))            $code = "CREATE";
    else                                              $code = "UPDATE";
    run("INSERT INTO activity_logs (user_id, action, description) VALUES (?, ?, ?)", "iss", [$u["id"], $code, $text]);
    out(["ok" => true]);

default:
    fail("Unknown action", 404);
}