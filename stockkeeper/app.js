const paint = (n) => {
  if (n.nodeType !== 1) return;
  [n, ...n.querySelectorAll("[data-st]")].forEach((x) => {
    if (x.dataset && x.dataset.st !== undefined) {
      x.style.cssText = x.dataset.st;
      x.removeAttribute("data-st");
    }
  });
};
const styleObserver = new MutationObserver((ms) =>
  ms.forEach((m) => m.addedNodes.forEach(paint)),
);
styleObserver.observe(document.documentElement, { childList: true, subtree: true });
const flushStyles = () =>
  styleObserver.takeRecords().forEach((m) => m.addedNodes.forEach(paint));

/* ============ HELPER FUNCTIONS ============ */
const $ = (s) => document.querySelector(s),
  $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
const money = (n) =>
  "₱" +
  n.toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const now = () => new Date().toISOString().slice(0, 16).replace("T", " ");

// ============ SHOW / HIDE PASSWORD BUTTON ============
const PWBTN =
  '<button type="button" class="pwt" aria-label="Show password" aria-pressed="false"><span class="ms">visibility</span></button>';
function setPwVisible(input, show) {
  const btn = input.parentElement.querySelector(".pwt");
  input.type = show ? "text" : "password";
  if (!btn) return;
  btn.setAttribute("aria-pressed", show);
  btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
  btn.querySelector(".ms").textContent = show ? "visibility_off" : "visibility";
}
document.addEventListener("mousedown", (ev) => {
  if (ev.target.closest(".pwt"))
    ev.preventDefault(); /* so the cursor stays inside the input box */
});
document.addEventListener("click", (ev) => {
  const b = ev.target.closest(".pwt");
  if (!b) return;
  const input = b.parentElement.querySelector("input");
  setPwVisible(input, input.type === "password");
});

/* ============ DATA ============ */
const db = {
  cust: [],
  cats: [],
  sup: [],
  prod: [],
  mov: [],
  sales: [],
  emp: [],
  logs: [],
  set: { store: "Stock Keeper", tax: 12, reorder: 20, footer: "" },
};
const productById = (id) => db.prod.find((p) => p.id === id) || {};
/* active products that would have no supplier left if supplier sid is archived */
const stuckProducts = (sid) =>
  db.prod.filter(
    (p) =>
      !p.arch &&
      (p.sups || []).includes(sid) &&
      !(p.sups || []).some(
        (x) => x !== sid && !(db.sup.find((s) => s.id === x) || {}).arch,
      ),
  );
/* active products that would have no category left if category cid is archived */
const stuckByCat = (cid) =>
  db.prod.filter(
    (p) =>
      !p.arch &&
      (p.cats || []).includes(cid) &&
      !(p.cats || []).some(
        (x) => x !== cid && !(db.cats.find((c) => c.id === x) || {}).arch,
      ),
  );
/* all the category names of a product (main category first) */
const catNames = (p) => (p.cats || []).map((id) => nameOf("cats", id));
/* turns the role keys into nice names, like ["manager","inventory"] becomes "Manager, Inventory staff" */
const roleLabels = (keys) => (keys || []).map((k) => ROLE[k] || k).join(", ");
const total = (s) => s.items.reduce((a, i) => a + i.qty * i.price, 0);
const nameOf = (l, id) => (db[l].find((x) => x.id === id) || { name: "—" }).name;

/* Talks to api.php. Gives back the data if it works, or null (and shows an error message) if it fails. */
async function api(action, data, quiet) {
  try {
    const r = await fetch("api.php?action=" + action, {
      method: data ? "POST" : "GET",
      headers: { "Content-Type": "application/json" },
      body: data ? JSON.stringify(data) : undefined,
      credentials: "same-origin",
    });
    const txt = await r.text();
    let j;
    api.last = { status: r.status };
    try {
      j = JSON.parse(txt);
    } catch (_) {
      if (!quiet)
        toast(
          "PHP error: " +
            txt
              .replace(/<[^>]*>/g, " ")
              .trim()
              .slice(0, 160),
          "bad",
        );
      return null;
    }
    if (!r.ok || j.error) {
      api.last = { status: r.status, error: j.error };
      if (r.status == 401 && me) {
        me = null;
        document.body.className = "";
        $("#login").classList.remove("hide");
        initLogin();
      }
      if (!quiet) toast(j.error || "Request failed", "bad");
      return null;
    }
    return j;
  } catch (_) {
    api.last = { status: 0 };
    if (!quiet)
      toast("Cannot reach the server. Is Apache/MySQL running?", "bad");
    return null;
  }
}
/* Loads all the data from the database again and updates the logged-in user. */
async function load(quiet) {
  const j = await api("bootstrap", null, quiet);
  if (!j) return false;
  me = j.user;
  Object.assign(db, j.data);
  return true;
}

/* ============ BASIC UI PARTS (buttons, tables, etc.) ============ */
function toast(msg, type) {
  if (
    type != "bad" &&
    !/^(Preparing|Purchase orders are|Password changes)/.test(msg)
  )
    log(msg);
  const t = document.createElement("div");
  t.className = "t " + (type || "");
  t.textContent = msg;
  $("#toasts").append(t);
  setTimeout(() => t.remove(), 3200);
}
/* rc is optional. It gives a row an extra class, like "arch" for archived records. */
function tbl(el, cols, rows, empty, rc) {
  if (!rows.length) {
    $(el).innerHTML = `<div class="em"><span class="ms">inbox</span><b>${empty || "Nothing here yet"}</b><p>Records you add will appear here.</p></div>`;
    return;
  }
  const header = cols.map((c) => `<th>${c[0]}</th>`).join("");
  const body = rows
    .map((r) => {
      const extraClass = rc && rc(r);
      const cells = cols
        .map((c) => `<td class="${c[2] || ""}">${c[1](r)}</td>`)
        .join("");
      return `<tr${extraClass ? ` class="${extraClass}"` : ""}>${cells}</tr>`;
    })
    .join("");
  $(el).innerHTML = `<table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
}
/* Archive helpers: we never delete records, we just mark them arch = true. */
const actv = (l) => db[l].filter((x) => !x.arch);
const arf = (sel) => {
  const v = $(sel).value;
  return (x) => v == "all" || (v == "arch" ? !!x.arch : !x.arch);
};
const archRow = (x) => (x.arch ? "arch" : "");
/* shows the added / updated (and archived) dates in every list */
const dts = (x) =>
  `<div class="mu2">Added ${esc(x.cr || "—")}</div><div class="mu2">Updated ${esc(x.up || "—")}</div>` +
  (x.ar ? `<div class="mu2">Archived ${esc(x.ar)}</div>` : "");
const archTag = (x) => (x.arch ? ' <span class="tg">Archived</span>' : "");
const archEmpty = (sel, what) =>
  $(sel).value == "arch" ? `No archived ${what}.` : null;
const acts = (s, id) => {
  if (!can("manage")) return "";
  const it = db[S[s].k].find((x) => x.id === id);
  // Edit is for admins and managers. Archive / Restore is for admins only.
  return it && it.arch
    ? can("archive")
      ? `<button class="b s" data-a="restore" data-s="${s}" data-id="${id}">Restore</button>`
      : ""
    : `<button class="b s" data-a="edit" data-s="${s}" data-id="${id}">Edit</button>` +
        (can("archive")
          ? ` <button class="b s" data-a="arch" data-s="${s}" data-id="${id}">Archive</button>`
          : "");
};
/* Employee buttons: Edit and an Active/Inactive switch (employees are never deleted or archived). */
const empActs = (u) =>
  !can("users")
    ? ""
    : `<button class="b s" data-a="edit" data-s="emp" data-id="${u.id}">Edit</button> ` +
      (u.status == "Active"
        ? `<button class="b s" data-a="empst" data-id="${u.id}" data-to="Inactive">Deactivate</button>`
        : `<button class="b s" data-a="empst" data-id="${u.id}" data-to="Active">Activate</button>`);
const dlg = $("#dlg");
dlg.addEventListener("click", (ev) => {
  if (ev.target.closest("[data-x]")) dlg.close();
});
dlg.addEventListener("close", () => (dlg.className = ""));
function ask(msg, fn, label) {
  dlg.innerHTML = `<h3>Please confirm</h3><p>${msg}</p><div class="ft"><button class="b" data-x>Cancel</button><button class="b p" id="ok">${label || "Confirm"}</button></div>`;
  dlg.showModal();
  $("#ok").onclick = () => {
    dlg.close();
    fn();
  };
}

/* Makes the pop-up forms we use everywhere, and checks if the inputs are correct. */
const EMAIL_RE =
  /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const PH_RE = /^09\d{9}$/; /* 09XXXXXXXXX, exactly 11 digits */
const LAND_RE = /^(09\d{9}|0[2-8]\d{7,9})$/; /* mobile or landline (for suppliers) */
function openForm(title, fs, vals, save) {
  const placeholderAttr = (f) =>
    f.ph ? ` placeholder="${esc(f.ph)}"` : "";
  const optionTags = (f) =>
    f.o.map((o) => `<option value="${o[0]}">${esc(o[1])}</option>`).join("");

  /* makes the right input box or dropdown for each kind of field */
  const renderControl = (f) => {
    if (f.t == "multi") {
      const size = Math.min(5, f.o.length || 1);
      return `<select name="${f.n}" multiple size="${size}">${optionTags(f)}</select>`;
    }
    if (f.t == "select") {
      const placeholder = f.ph
        ? `<option value="" disabled selected hidden>${esc(f.ph)}</option>`
        : "";
      return `<select name="${f.n}">${placeholder}${optionTags(f)}</select>`;
    }
    if (f.t == "password") {
      return `<span class="pw"><input name="${f.n}" type="password"${placeholderAttr(f)}>${PWBTN}</span>`;
    }
    const readonly = f.ro ? " readonly" : "";
    const numberAttrs =
      f.t == "number" ? ` min="${f.min ?? 0}" step="${f.step || 1}"` : "";
    return `<input name="${f.n}" type="${f.t || "text"}"${readonly}${numberAttrs}>`;
  };

  const renderField = (f) => {
    const hint = f.h ? `<small class="hint">${f.h}</small>` : "";
    return `<label>${f.l}${renderControl(f)}${hint}<small class="er"></small></label>`;
  };

  /* No spaces between the tags on purpose so the design doesn't get extra gaps. */
  const buttons =
    `<button type="button" class="b" data-x>Cancel</button>` +
    `<button class="b p">Save</button>`;
  dlg.innerHTML =
    `<form novalidate><h3>${title}</h3>${fs.map(renderField).join("")}` +
    `<div class="ft">${buttons}</div></form>`;
  const fm = dlg.querySelector("form");
  fs.forEach((f) => {
    let v = vals[f.n];
    if (v === undefined) return;
    if (f.t == "tel") v = v == "—" ? "" : String(v).replace(/[\s()-]/g, "");
    if (f.t == "multi") {
      [...fm.elements[f.n].options].forEach(
        (o) => (o.selected = v.map(String).includes(o.value)),
      );
      return;
    }
    fm.elements[f.n].value = v;
  });
  const read = () => {
    const d = {};
    fs.forEach((f) => {
      if (f.t == "multi") {
        d[f.n] = [...fm.elements[f.n].selectedOptions].map((o) =>
          f.str ? o.value : +o.value,
        );
        return;
      }
      const x = fm.elements[f.n].value.trim();
      d[f.n] = f.t == "number" || f.num ? (x === "" ? NaN : +x) : x;
    });
    return d;
  };
  const lab = (f) => fm.elements[f.n].closest("label");
  /* A field is "touched" once the user types in it or clicks out of it.
     Touched fields get checked again every time the user types or changes something, and they stay red
     until they are correct. Fields that are not touched yet are only checked when the form is submitted. */
  const touched = new Set();
  /* gives true if the field is WRONG, and also shows or removes the red color */
  const check = (f, d) => {
    const el = fm.elements[f.n],
      x = d[f.n],
      empty = x === "" || Number.isNaN(x),
      bad = f.t == "number" && el.validity.badInput;
    let m = "";
    if (bad) m = "Enter a valid number";
    else if (empty && !f.opt) m = "This field is required";
    else if (!empty && f.t == "number" && x < (f.min ?? 0))
      m = "Enter at least " + (f.min ?? 0);
    else if (!empty && f.t == "number" && !f.step && !Number.isInteger(x))
      m = "Enter a whole number";
    else if (!empty && f.t == "email" && !EMAIL_RE.test(x))
      m = "Enter a valid email address (e.g. name@example.com)";
    else if (!empty && f.t == "tel" && !(f.land ? LAND_RE : PH_RE).test(x))
      m = f.land
        ? "Enter a mobile (09XXXXXXXXX) or landline number (e.g. 028XXXXXXX)"
        : "Enter an 11-digit mobile number starting with 09 (09XXXXXXXXX)";
    else if (!empty && f.v) m = f.v(x, d) || "";
    lab(f).classList.toggle("e", !!m);
    lab(f).querySelector(".er").textContent = m;
    if (m) el.setAttribute("aria-invalid", "true");
    else el.removeAttribute("aria-invalid");
    return !!m;
  };
  const fieldOf = (ev) => fs.find((x) => x.n == ev.target.name);
  /* check all the touched fields again, in case one depends on another
     (like choosing another product re-checks the quantity, or changing the password re-checks the confirm password) */
  const revalidate = () => {
    const d = read();
    fs.forEach((f) => touched.has(f.n) && check(f, d));
  };
  let cancelling = false; /* so an error message doesn't push the Cancel button away right when we click it */
  fm.addEventListener("pointerdown", (ev) => {
    cancelling = !!ev.target.closest("[data-x]");
  });
  const onEdit = (ev) => {
    const f = fieldOf(ev);
    if (!f || f.ro) return;
    touched.add(f.n);
    revalidate();
  };
  fm.addEventListener("input", onEdit);
  fm.addEventListener("change", onEdit);
  fm.addEventListener("focusout", (ev) => {
    const f = fieldOf(ev);
    if (!f || f.ro || cancelling) return;
    touched.add(f.n);
    revalidate();
  });
  fm.onsubmit = async (ev) => {
    ev.preventDefault();
    const d = read();
    let first = null;
    fs.forEach((f) => {
      touched.add(f.n);
      if (check(f, d) && !first) first = f;
    });
    if (first) {
      const el = fm.elements[first.n];
      if (!el.readOnly) el.focus();
      return toast("Fix the highlighted fields", "bad");
    }
    /* keep the form open if saving fails so what the user typed is not lost */
    const btn = fm.querySelector("button.p");
    btn.disabled = true;
    let ok;
    try {
      ok = await save(d);
    } finally {
      btn.disabled = false;
    }
    if (ok !== false) dlg.close();
  };
  dlg.showModal();
}

/* ============ ADD / EDIT / ARCHIVE: products, categories, suppliers ============ */
/* Shows a preview of the SKU the server will give (same rule as next_sku() in api.php,
   the server still decides the real one). Gives "" if no category is picked yet. */
function nextSku(catId) {
  const c = db.cats.find((x) => x.id === catId);
  if (!c) return "";
  const same = db.prod
    .filter((p) => p.cat === catId && p.sku.includes("-"))
    .sort((a, b) => a.id - b.id)[0];
  let pre;
  if (same) pre = same.sku.split("-")[0];
  else {
    const w = c.name.split(/[^A-Za-z]+/).filter(Boolean);
    pre = (w.length > 1 ? w[0][0] + w[1][0] : (w[0] || "XX").slice(0, 2)).toUpperCase();
  }
  let top = 0;
  db.prod.forEach((p) => {
    if (p.sku.startsWith(pre + "-"))
      top = Math.max(top, parseInt(p.sku.split("-").pop(), 10) || 0);
  });
  return pre + "-" + (Math.max(top, catId * 1000) + 1);
}
const S = {
  prod: {
    k: "prod",
    t: "Product",
    f: () => [
      {
        n: "sku",
        l: 'SKU <span class="auto" title="Auto-generated">*</span>',
        ro: 1,
        opt: 1,
        h: '<span class="auto">*</span> Auto-generated from the main category. It cannot be edited.',
      },
      { n: "name", l: "Product name", ph: "e.g. Portland Cement 40 kg" },
      {
        n: "cat",
        l: "Main category",
        t: "select",
        num: 1,
        ph: "Select a category",
        o: actv("cats").map((c) => [c.id, c.name]),
      },
      {
        n: "cats",
        l: "Other categories (optional)",
        t: "multi",
        opt: 1,
        h: "A product can belong to several categories. Hold Ctrl (Cmd on Mac) to pick more than one.",
        o: actv("cats").map((c) => [c.id, c.name]),
      },
      {
        n: "sup",
        l: "Main supplier",
        t: "select",
        num: 1,
        ph: "Select a supplier",
        o: actv("sup").map((c) => [c.id, c.name]),
      },
      {
        n: "sups",
        l: "Other suppliers (optional)",
        t: "multi",
        opt: 1,
        h: "Backup suppliers for this product. Hold Ctrl (Cmd on Mac) to pick more than one.",
        o: actv("sup").map((c) => [c.id, c.name]),
      },
      {
        n: "price",
        l: "Unit price (₱)",
        t: "number",
        min: 0.01,
        step: ".01",
        ph: "e.g. 265.00",
      },
      { n: "stock", l: "Stock on hand", t: "number", ph: "e.g. 100" },
      { n: "min", l: "Reorder level", t: "number", ph: "e.g. 20" },
      {
        n: "unit",
        l: "Unit (pcs, kg, roll)",
        ph: "e.g. bag, pcs, kg",
        v: (value) =>
          /^[a-zA-Z ]+$/.test(String(value).trim())
        ? ""
        : "Letters only. Numbers and special characters are not allowed",
      },
    ],
  },
  cat: {
    k: "cats",
    t: "Category",
    f: () => [
      { n: "name", l: "Category name", ph: "e.g. Cement & Masonry" },
      {
        n: "desc",
        l: "Description",
        opt: 1,
        ph: "Short description (optional)",
      },
    ],
  },
  sup: {
    k: "sup",
    t: "Supplier",
    f: () => [
      { n: "name", l: "Company", ph: "e.g. Calamba Cement & Masonry Depot" },
      { n: "contact", l: "Contact person", ph: "e.g. Juan Dela Cruz" },
      { n: "street", l: "Street / building (optional)", opt: 1, ph: "e.g. MacArthur Highway" },
      { n: "brgy", l: "Barangay", ph: "e.g. Real" },
      { n: "city", l: "City / Municipality", ph: "e.g. Calamba City" },
      { n: "prov", l: "Province", ph: "e.g. Laguna" },
      { n: "phone", l: "Phone", t: "tel", land: 1, ph: "09XXXXXXXXX or 028XXXXXXX" },
      { n: "email", l: "Email (optional)", t: "email", opt: 1, ph: "name@company.com" },
    ],
  },
  cust: {
    k: "cust",
    t: "Customer",
    f: () => [
      {
        n: "code",
        l: "Customer ID",
        ro: 1,
        opt: 1,
        h: '<span class="auto">*</span> Auto-generated. It cannot be edited.',
      },
      { n: "name", l: "Customer name", ph: "e.g. Maria Santos" },
      { n: "phone", l: "Mobile number", t: "tel", ph: "09XXXXXXXXX" },
      { n: "street", l: "Street / building (optional)", opt: 1, ph: "e.g. 12 Rizal St." },
      { n: "brgy", l: "Barangay", ph: "e.g. Banay-banay" },
      { n: "city", l: "City / Municipality", ph: "e.g. Cabuyao" },
      { n: "prov", l: "Province", ph: "e.g. Laguna" },
    ],
  },
};
const API = {
  prod: "product",
  cat: "category",
  sup: "supplier",
  cust: "customer",
  emp: "employee",
};
function edit(s, id) {
  if (!can(s == "emp" ? "users" : s == "cust" ? "customers" : "manage"))
    return deny();
  if (s == "emp" && id === me.id)
    return toast("Ask another administrator to edit your own record", "bad");
  const c = S[s],
    it = id
      ? db[c.k].find((x) => x.id === id)
      : s == "prod"
        ? { min: db.set.reorder, stock: 0 }
        : {};
  const fs = c.f();
  if (s == "prod" && !can("stock")) {
    const sf = fs.find((f) => f.n == "stock");
    sf.ro = 1;
    sf.opt = 1;
    sf.h = "Only inventory staff can change quantities.";
  }
  if (s == "emp" && !id)
    fs.push({
      n: "pw",
      l: "Password",
      t: "password",
      ph: "At least 6 characters",
      v: (x) => (x.length < 6 ? "Use at least 6 characters" : ""),
    });
  const vals =
    s == "prod" && id
      ? {
          ...it,
          sups: (it.sups || []).filter((x) => x !== it.sup), // the "other" suppliers are all the suppliers except the main one
          cats: (it.cats || []).filter((x) => x !== it.cat), // the "other" categories are all the categories except the main one
        }
      : s == "cust" && !id
        ? { code: "Assigned when you save" }
        : it;
  openForm((id ? "Edit " : "Add ") + c.t.toLowerCase(), fs, vals, async (d) => {
    const j = await api("save_" + API[s], { ...d, id });
    if (!j) return false;
    await load();
    show(cur);
    toast(
      c.t +
        (id ? " updated: " : " added: ") +
        d.name +
        (j.username ? ". Username: " + j.username : ""),
    );
  });
  if (s == "prod" && !id)
    dlg.querySelector('[name="cat"]').onchange = (ev) =>
      (dlg.querySelector('[name="sku"]').value = nextSku(+ev.target.value));
}
/* We archive instead of delete. The record stays in the database and can be brought back. */
function archive(s, id) {
  if (!can("archive")) return deny();
  const c = S[s],
    it = db[c.k].find((x) => x.id === id);
  const why =
    s == "cat" && stuckByCat(id).length
      ? "Add another category to these products first: " +
        stuckByCat(id)
          .slice(0, 3)
          .map((p) => p.name)
          .join(", ")
      : s == "sup" && stuckProducts(id).length
        ? "Add another supplier to these products first: " +
          stuckProducts(id)
            .slice(0, 3)
            .map((p) => p.name)
            .join(", ")
        : "";
  if (why) return toast(why, "bad");
  const note =
    s == "prod"
      ? "It will be hidden from sales, stock forms and reports."
      : s == "cust"
        ? "It will no longer be offered when making a sale. Past sales keep the customer name."
        : "It will be hidden from lists and forms.";
  ask(
    `Archive <b>${esc(it.name)}</b>? ${note} Nothing is deleted. You can restore it any time by switching the filter to Archived.`,
    async () => {
      if (!(await api("archive_" + API[s], { id }))) return;
      await load();
      show(cur);
      toast(c.t + " archived: " + it.name);
    },
    "Archive",
  );
}
/* Switches an employee between Active and Inactive. Inactive accounts can't log in, but their records stay. */
function setEmpStatus(id, status) {
  if (!can("users")) return deny();
  const it = db.emp.find((x) => x.id === id);
  if (!it) return;
  if (id === me.id)
    return toast(
      "You cannot change the status of your own account here",
      "bad",
    );
  if (
    status == "Inactive" &&
    (it.roles || []).includes("admin") &&
    db.emp.filter((u) => (u.roles || []).includes("admin") && u.status == "Active")
      .length < 2
  )
    return toast("You cannot deactivate the last active administrator", "bad");
  const go = async () => {
    if (!(await api("set_employee_status", { id, status }))) return;
    await load();
    show(cur);
    toast(
      `Employee ${status == "Active" ? "activated" : "deactivated"}: ${it.name}`,
    );
  };
  if (status == "Active") return go();
  ask(
    `Deactivate <b>${esc(it.name)}</b>? They will no longer be able to sign in. Their records and history are kept, and you can activate the account again at any time.`,
    go,
    "Deactivate",
  );
}
async function restore(s, id) {
  if (!can("archive")) return deny();
  const c = S[s],
    it = db[c.k].find((x) => x.id === id);
  if (!(await api("restore_" + API[s], { id }))) return;
  await load();
  show(cur);
  toast(c.t + " restored: " + it.name);
}

/* ============ CHARTS (Chart.js) ============ */
const ch = {};
function mk(id, type, labels, data, label) {
  if (!window.Chart) return;
  ch[id] && ch[id].destroy();
  const cs = getComputedStyle(document.documentElement),
    ink = cs.getPropertyValue("--ink").trim(),
    ln = cs.getPropertyValue("--ln").trim();
  Chart.defaults.color = ink;
  Chart.defaults.font.family = "Plus Jakarta Sans, sans-serif";
  Chart.defaults.borderColor = ln;
  const pal = isDark()
      ? ["#7FA6F0", "#93A1B8", "#FBBF24", "#5EEAD4", "#C4B5FD", "#FDA4AF"]
      : ["#34495E", "#7C8B9A", "#D97706", "#9FB0C0", "#5B6B7B", "#C4CCD4"],
    bar = type == "bar";
  ch[id] = new Chart($("#" + id), {
    type,
    data: {
      labels,
      datasets: [
        {
          label,
          data,
          backgroundColor: bar ? pal[0] : pal,
          borderColor: ln,
          borderWidth: 2,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { display: !bar, position: "bottom" } },
      scales: bar
        ? {
            y: { beginAtZero: true, grid: { color: ln + "44" } },
            x: { grid: { display: false } },
          }
        : {},
    },
  });
}

/* ============ FUNCTIONS THAT SHOW EACH PAGE ============ */
const saleCols = [
  ["Receipt", (s) => `<b>${s.id}</b>`, "m"],
  ["Date", (s) => s.date, "m"],
  ["Customer", (s) => esc(s.cust) + (s.cid ? `<div class="mu2">${esc(s.cid)}</div>` : "")],
  ["Lines", (s) => s.items.length],
  ["Cashier", (s) => esc(s.by || "—")],
  ["Payment", (s) => esc(s.pay)],
  ["Total", (s) => money(total(s)), "m"],
  [
    "",
    (s) =>
      `<button class="b s" data-a="sale" data-id="${s.id}">Details</button>`,
    "act",
  ],
];

function rProd() {
  const sel = $("#pc"),
    cur0 = sel.value;
  sel.innerHTML =
    '<option value="">All categories</option>' +
    db.cats
      .map(
        (c) =>
          `<option value="${c.id}">${esc(c.name)}${c.arch ? " (archived)" : ""}</option>`,
      )
      .join("");
  sel.value = cur0;
  const q = $("#pq").value.toLowerCase(),
    c = +sel.value;
  const rows = db.prod.filter(
    (p) =>
      (!c || (p.cats || []).includes(c)) &&
      arf("#pa")(p) &&
      (p.name + p.sku).toLowerCase().includes(q),
  );
  tbl(
    "#ptbl",
    [
      ["SKU", (p) => esc(p.sku), "m"],
      [
        "Product",
        (p) =>
          `<div class="pn"><span class="ch" data-st="--c:${cc(p.cat)}"><span class="ms">${ci(p.cat)}</span></span><b>${esc(p.name)}</b></div>`,
      ],
      [
        "Category",
        (p) =>
          `<span class="cd" data-st="--c:${cc(p.cat)}"></span>${esc(nameOf("cats", p.cat))}` +
          ((p.cats || []).length > 1
            ? `<div class="mu2">Also: ${esc(catNames(p).slice(1).join(", "))}</div>`
            : ""),
      ],
      [
        "Supplier",
        (p) =>
          esc(nameOf("sup", p.sup)) +
          ((p.sups || []).length > 1
            ? `<div class="mu2">+${p.sups.length - 1} more</div>`
            : ""),
      ],
      ["Price", (p) => money(p.price), "m"],
      ["Stock level", (p) => stk(p)],
      ["Status", (p) => bdg(p)],
      ["Added / updated", dts],
      ["", (p) => prodActs(p.id), "act"],
    ],
    rows,
    archEmpty("#pa", "products") || "No products match your search.",
    archRow,
  );
}
function rCat() {
  tbl(
    "#ctbl",
    [
      ["Category", (c) => `<b>${esc(c.name)}</b>${archTag(c)}`],
      ["Description", (c) => esc(c.desc || "")],
      [
        "Products",
        (c) => actv("prod").filter((p) => (p.cats || []).includes(c.id)).length,
        "m",
      ],
      ["Added / updated", dts],
      ["", (c) => acts("cat", c.id), "act"],
    ],
    db.cats.filter(arf("#ca")),
    archEmpty("#ca", "categories") ||
      "No categories yet. Add one to organise products.",
    archRow,
  );
}
function rSup() {
  tbl(
    "#stbl",
    [
      [
        "Company",
        (s) =>
          `<div class="pn"><span class="ch" data-st="--c:${cc(s.id)}"><span class="ms">local_shipping</span></span><b>${esc(s.name)}</b>${archTag(s)}</div>`,
      ],
      ["Contact", (s) => esc(s.contact)],
      ["Barangay", (s) => esc(s.brgy || "—")],
      [
        "City",
        (s) =>
          s.city || s.prov
            ? esc(s.city || "—") + (s.prov ? `<div class="mu2">${esc(s.prov)}</div>` : "")
            : esc(s.addr || "—"),
      ],
      ["Phone", (s) => esc(s.phone), "m"],
      ["Email", (s) => esc(s.email)],
      [
        "Products",
        (s) => {
          const l = actv("prod").filter((p) => (p.sups || []).includes(s.id));
          const m = l.filter((p) => p.sup === s.id).length;
          return l.length + (m ? `<div class="mu2">${m} as main</div>` : "");
        },
        "m",
      ],
      ["", (s) => acts("sup", s.id), "act"],
    ],
    db.sup.filter(arf("#sa")),
    archEmpty("#sa", "suppliers") || "No suppliers yet.",
    archRow,
  );
}
function rCust() {
  const q = ($("#cq").value || "").toLowerCase();
  tbl(
    "#cutbl",
    [
      ["Customer ID", (c) => esc(c.code || "—"), "m"],
      ["Customer", (c) => `<b>${esc(c.name)}</b>${archTag(c)}`],
      ["Mobile", (c) => esc(c.phone), "m"],
      [
        "Address",
        (c) =>
          esc([c.street, c.brgy, c.city, c.prov].filter(Boolean).join(", ")),
      ],
      ["Added / updated", dts],
      ["", (c) => custActs(c), "act"],
    ],
    db.cust
      .filter(arf("#cua"))
      .filter((c) =>
        (c.code + " " + c.name + " " + c.brgy + " " + c.city).toLowerCase().includes(q),
      ),
    archEmpty("#cua", "customers") || "No customers yet.",
    archRow,
  );
}
/* Customers: admin, manager and cashier can edit, only the admin can archive/restore */
function custActs(c) {
  if (!can("customers")) return "";
  if (c.arch)
    return can("archive")
      ? `<button class="b s" data-a="restore" data-s="cust" data-id="${c.id}">Restore</button>`
      : "";
  return (
    `<button class="b s" data-a="edit" data-s="cust" data-id="${c.id}">Edit</button>` +
    (can("archive")
      ? ` <button class="b s" data-a="arch" data-s="cust" data-id="${c.id}">Archive</button>`
      : "")
  );
}
function rMov() {
  const f = $("#mf").value;
  tbl(
    "#mtbl",
    [
      ["Date", (m) => m.date, "m"],
      ["Product", (m) => esc(productById(m.pid).name || "—")],
      [
        "Type",
        (m) =>
          `<span class="tg ${m.type == "IN" ? "ok" : "bd"}">${m.type == "IN" ? "Stock in" : "Stock out"}</span>`,
      ],
      ["Qty", (m) => (m.type == "IN" ? "+" : "−") + m.qty, "m"],
      ["Reference / reason", (m) => esc(m.note)],
      ["Handled by", (m) => (m.by ? av(m.by, "sm") + " " + esc(m.by) : "—")],
    ],
    db.mov.filter((m) => !f || m.type == f).reverse(),
  );
}
function rSales() {
  const q = $("#sq").value.toLowerCase();
  tbl(
    "#stbl2",
    saleCols,
    db.sales.filter((s) => (s.id + s.cust + (s.cid || "")).toLowerCase().includes(q)).reverse(),
    "No sales match your search.",
  );
}
function rRep() {
  const rows = actv("prod")
    .slice()
    .sort((a, b) => b.id - a.id); /* newest first */
  tbl(
    "#rinv",
    [
      ["SKU", (p) => esc(p.sku), "m"],
      ["Product", (p) => esc(p.name)],
      ["Category", (p) => esc(catNames(p).join(", ") || "—")],
      ["On hand", (p) => p.stock, "m"],
      ["Reorder at", (p) => p.min, "m"],
      ["Value", (p) => money(p.stock * p.price), "m"],
      [
        "Status",
        (p) =>
          `<span class="tg ${p.stock <= p.min ? "bd" : "ok"}">${p.stock <= p.min ? "Low" : "OK"}</span>`,
      ],
    ],
    rows,
  );
  $("#rtot").textContent =
    `Total inventory value: ${money(rows.reduce((a, p) => a + p.stock * p.price, 0))} across ${rows.length} products.`;
  const day = {},
    pay = {};
  db.sales.forEach((s) => {
    const d = s.date.slice(0, 10);
    day[d] = (day[d] || 0) + total(s);
    pay[s.pay] = pay[s.pay] || [0, 0];
    pay[s.pay][0]++;
    pay[s.pay][1] += total(s);
  });
  mk(
    "c3",
    "bar",
    Object.keys(day).map(fd),
    Object.values(day).map((v) => Math.round(v)),
    "Revenue (₱)",
  );
  tbl(
    "#rpay",
    [
      ["Method", (r) => esc(r[0])],
      ["Transactions", (r) => r[1][0], "m"],
      ["Revenue", (r) => money(r[1][1]), "m"],
    ],
    Object.entries(pay),
  );
}

/* ============ STOCK IN / STOCK OUT (inventory movements) ============ */
function mvForm(type) {
  const out = type == "OUT";
  openForm(
    out ? "Record stock out" : "Record stock in",
    [
      {
        n: "pid",
        l: "Product",
        t: "select",
        num: 1,
        ph: "Select a product",
        o: actv("prod").map((p) => [
          p.id,
          `${p.sku} – ${p.name} (${p.stock} on hand)`,
        ]),
      },
      {
        n: "qty",
        l: "Quantity",
        t: "number",
        min: 1,
        ph: "e.g. 10",
        v: (x, d) =>
          out && x > productById(d.pid).stock ? `Only ${productById(d.pid).stock} on hand` : "",
      },
      {
        n: "note",
        l: out
          ? "Reason (job site, damage, transfer)"
          : "Reference (PO or delivery no.)",
        opt: 1,
        ph: out
          ? "e.g. Job site, damaged, transfer"
          : "e.g. PO-2226 or delivery no.",
      },
    ],
    {},
    async (d) => {
      if (
        !(await api("add_movement", {
          pid: d.pid,
          type,
          qty: d.qty,
          note: d.note,
        }))
      )
        return false;
      await load();
      show(cur);
      toast(`${out ? "Stock out" : "Stock in"}: ${d.qty} × ${productById(d.pid).name}`);
    },
  );
}

/* ============ SALES ============ */
function newSale() {
  openForm(
    "New sale",
    [
      {
        n: "cust",
        l: "Customer",
        t: "select",
        num: 1,
        o: [[0, "Walk-in"], ...actv("cust").map((c) => [c.id, `${c.code} · ${c.name} (${c.brgy}, ${c.city})`])],
      },
      {
        n: "pid",
        l: "Product",
        t: "select",
        num: 1,
        ph: "Select a product",
        o: actv("prod").map((p) => [
          p.id,
          `${p.name} – ${money(p.price)} (${p.stock} in stock)`,
        ]),
      },
      {
        n: "qty",
        l: "Quantity",
        t: "number",
        min: 1,
        ph: "e.g. 5",
        v: (x, d) =>
          x > productById(d.pid).stock ? `Only ${productById(d.pid).stock} in stock` : "",
      },
      {
        n: "pay",
        l: "Payment method",
        t: "select",
        ph: "Select payment method",
        o: ["Cash", "GCash", "Maya", "Bank transfer", "Charge account"].map(
          (x) => [x, x],
        ),
      },
    ],
    {},
    async (d) => {
      const j = await api("add_sale", {
        cust_id: d.cust,
        pid: d.pid,
        qty: d.qty,
        pay: d.pay,
      });
      if (!j) return false;
      await load();
      show(cur);
      toast("Sale " + j.receipt + " saved");
    },
  );
}
function saleInfo(id) {
  const s = db.sales.find((x) => x.id == id);
  const vat = (total(s) * db.set.tax) / (100 + db.set.tax);
  const customerId = s.cid ? " (" + esc(s.cid) + ")" : "";

  const itemRows = s.items
    .map(
      (i) =>
        `<tr><td>${esc(i.name || productById(i.pid).name || "—")}</td>` +
        `<td class="m">${i.qty}</td>` +
        `<td class="m">${money(i.price)}</td>` +
        `<td class="m">${money(i.qty * i.price)}</td></tr>`,
    )
    .join("");

  dlg.innerHTML =
    `<h3>Receipt ${s.id}</h3>` +
    `<p class="mu" data-st="margin:0 0 12px">${s.date} · ${esc(s.cust)}${customerId} · ${esc(s.pay)}</p>` +
    `<div class="tw"><table><thead><tr><th>Item</th><th>Qty</th><th>Price</th><th>Subtotal</th></tr></thead>` +
    `<tbody>${itemRows}</tbody></table></div>` +
    `<h3 data-st="margin-top:14px">Total ${money(total(s))}</h3>` +
    `<p class="mu" data-st="margin:4px 0 0">Includes ${db.set.tax}% VAT: ${money(vat)} · Cashier: ${esc(s.by || "—")}</p>` +
    `<div class="ft"><button class="b p" data-x>Close</button></div>`;
  dlg.showModal();
}

/* ============ MENU, DARK/LIGHT MODE, BUTTON CLICKS ============ */
const V = [
  ["dashboard", "Dashboard", "dashboard", () => rHome()],
  ["products", "Products", "inventory_2", rProd],
  ["categories", "Categories", "category", rCat],
  ["suppliers", "Suppliers", "local_shipping", rSup],
  ["movements", "Inventory movements", "swap_vert", rMov],
  ["sales", "Sales", "receipt_long", rSales],
  ["reports", "Reports", "summarize", rRep],
];
let cur = "dashboard";
// ============ ROLES, LOGIN, EMPLOYEES, LOGS, SETTINGS ============
V.push(
  ["customers", "Customers", "groups", rCust],
  ["employees", "Employees", "badge", rEmp],
  ["logs", "Activity logs", "history", rLogs],
  ["settings", "Settings", "settings", rSet],
  ["profile", "Profile", "account_circle", rProfile],
);
// THE ROLE NAMES
const ROLE = {
  admin: "Administrator",
  manager: "Manager",
  inventory: "Inventory staff",
  cashier: "Cashier",
};
const VIEWS = {
  admin: null,
  manager: [
    "dashboard",
    "products",
    "categories",
    "suppliers",
    "movements",
    "sales",
    "customers",
    "reports",
  ],
  inventory: ["dashboard", "products", "suppliers", "movements"],
  cashier: ["sales", "customers", "products"],
};
const CAN = {
  manage: ["admin", "manager"],
  users: ["admin"],
  stock: ["admin", "inventory"],
  sell: ["admin", "cashier"],
  archive: ["admin"],
  customers: ["admin", "manager", "cashier"],
};
/* What each role is responsible for (shown on the Employees page) */
const DUTY = {
  admin: [
    "Full control of the system: employee accounts, roles, activate/deactivate, archive and restore records, activity logs.",
    "Nothing is restricted.",
  ],
  manager: [
    "Maintains the catalog (products, prices, reorder levels, categories, suppliers) and customer records. Reviews sales, stock movements and reports.",
    "Cannot process sales, change stock quantities, archive or restore records, or manage employees.",
  ],
  inventory: [
    "Receives and issues stock, records count adjustments, checks suppliers and delivery history.",
    "Cannot change products, prices, categories or suppliers, cannot sell, and cannot see reports or employees.",
  ],
  cashier: [
    "Processes sales for registered customers and keeps customer records. Looks up products and stock.",
    "Cannot change products, stock or suppliers, and cannot see reports or employees.",
  ],
};
/* An employee can have many roles. They can do whatever any of their roles can do. */
const can = (k) => !!me && (me.roles || []).some((r) => CAN[k].includes(r));
let me = null;
const ADM = () => me && (me.roles || []).includes("admin");
// CHECKS WHICH PAGES THE USER IS ALLOWED TO OPEN
const allowed = (v) =>
  v == "profile" ||
  v == "settings" ||
  (me.roles || []).some((r) => !VIEWS[r] || VIEWS[r].includes(v));
const deny = () => toast("Permission denied: your role cannot do this", "bad");
S.emp = {
  k: "emp",
  t: "Employee",
  f: () => [
    { n: "name", l: "Full name", ph: "e.g. Maria Santos" },
    { n: "title", l: "Position", opt: 1, ph: "e.g. Cashier" },
    {
      n: "roles",
      l: "Roles",
      t: "multi",
      str: 1,
      h: "An employee can hold several roles and gets the permissions of all of them. Hold Ctrl (Cmd on Mac) to pick more than one.",
      o: Object.entries(ROLE),
      v: (x) => (x.length ? "" : "Choose at least one role"),
    },
    { n: "phone", l: "Phone", t: "tel", opt: 1, ph: "09XXXXXXXXX" },
  ],
};
function log() {} /* the activity logs are saved by api.php, not by the browser */
// The side menu is grouped, and only shows what the role can use
const GRP = {
    dashboard: 0,
    products: 1,
    categories: 1,
    movements: 1,
    suppliers: 2,
    sales: 3,
    customers: 3,
    reports: 4,
    employees: 5,
    logs: 5,
    settings: 6,
    profile: 6,
  },
  GN = [
    "Overview",
    "Inventory",
    "Procurement",
    "Sales",
    "Analytics",
    "Administration",
    "Account",
  ];
function buildNav() {
  let g = -1;
  $("#nav").innerHTML = V.filter(
    (a) => allowed(a[0]) && a[0] != "profile" && a[0] != "settings",
  )
    .sort((a, b) => GRP[a[0]] - GRP[b[0]])
    .map((a) => {
      const h = GRP[a[0]] != g ? `<div class="ng">${GN[GRP[a[0]]]}</div>` : "";
      g = GRP[a[0]];
      return (
        h +
        `<button data-v="${a[0]}"><span class="ms">${a[2]}</span>${a[1]}</button>`
      );
    })
    .join("");
}
function setRole() {
  $("#sf").innerHTML = `<span class="av">${me.name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(
      0,
      2,
    )}</span><div><b>${esc(me.name)}</b><small>${esc(roleLabels(me.roles))}</small></div>`;
  document.body.className = [
    !can("manage") && "nm",
    !can("stock") && "ns",
    !can("sell") && "nl",
  ]
    .filter(Boolean)
    .join(" ");
}
$("#gs").onkeydown = (ev) => {
  if (ev.key == "Enter") {
    $("#pq").value = ev.target.value;
    ev.target.value = "";
    show("products");
  }
};
const prodActs = (id) =>
  acts("prod", id) +
  " " +
  (productById(id).arch
    ? ""
    : `<button class="b s stk" data-a="adj" data-id="${id}">Adjust stock</button>`);
function rEmp() {
  const q = $("#eq").value.toLowerCase();
  tbl(
    "#etbl",
    [
      ["Name", (u) => `<div class="pn">${av(u.name)}<b>${esc(u.name)}</b></div>`],
      ["Username", (u) => esc(u.username), "m"],
      ["Position", (u) => esc(u.title)],
      [
        "Roles",
        (u) =>
          (u.roles || [])
            .map(
              (k) =>
                `<span class="tg ${k == "admin" ? "ok" : ""}">${esc(ROLE[k] || k)}</span>`,
            )
            .join(" ") || "—",
      ],
      ["Phone", (u) => esc(u.phone), "m"],
      [
        "Status",
        (u) =>
          `<span class="tg ${u.status == "Active" ? "ok" : "bd"}">${u.status}</span>`,
      ],
      ["Added / updated", dts],
      ["", (u) => empActs(u), "act"],
    ],
    db.emp.filter(
      (u) =>
        (!$("#ea").value || u.status == $("#ea").value) &&
        (u.name + u.title + roleLabels(u.roles)).toLowerCase().includes(q),
    ),
    "No employees match your filter.",
    (u) => (u.status == "Inactive" ? "arch" : ""),
  );
  $("#roles").innerHTML =
    "<h3>Role responsibilities</h3>" +
    Object.keys(ROLE)
      .map(
        (k) =>
          `<p class="mu flush"><b>${ROLE[k]}</b><br>${esc(DUTY[k][0])}<br>${esc(DUTY[k][1])}</p>`,
      )
      .join("");
}
function rLogs() {
  const q = $("#lq").value.toLowerCase();
  $("#ltbl").innerHTML = tlHtml(
    db.logs.filter((l) => (l.u + l.a).toLowerCase().includes(q)).reverse(),
  );
  rHist(q);
}
/* Change history: shows the old values of records that were edited, archived or restored */
const HT = {
  products: ["Product", "product_name"],
  categories: ["Category", "category_name"],
  suppliers: ["Supplier", "company_name"],
  customers: ["Customer", "customer_name"],
  users: ["Employee", "full_name"],
  settings: ["Store settings", "store_name"],
};
const HF = {
  sku: "SKU",
  product_name: "Name",
  category_id: "Category",
  categories: "Categories",
  roles: "Roles",
  supplier_id: "Supplier",
  unit_price: "Unit price",
  reorder_level: "Reorder level",
  unit: "Unit",
  category_name: "Name",
  description: "Description",
  company_name: "Company",
  contact_person: "Contact person",
  phone: "Phone",
  email: "Email",
  address: "Address",
  customer_name: "Name",
  street: "Street",
  barangay: "Barangay",
  city: "City",
  province: "Province",
  full_name: "Name",
  username: "Username",
  role_id: "Role",
  job_title: "Position",
  status: "Status",
  store_name: "Store name",
  tax_rate: "Tax rate (%)",
  receipt_footer: "Receipt footer",
};
const hv = (k, v) =>
  v === null || v === "" || v === undefined || (Array.isArray(v) && !v.length)
    ? "—"
    : Array.isArray(v)
      ? v.join(", ")
      : k == "category_id"
      ? nameOf("cats", +v)
      : k == "supplier_id"
        ? nameOf("sup", +v)
        : k == "role_id"
          ? ROLE[["", "admin", "manager", "inventory", "cashier"][+v]] || v
          : String(v);
const hdiff = (h) =>
  Object.keys(h.new)
    .filter(
      (k) =>
        JSON.stringify(h.old[k]) !== JSON.stringify(h.new[k]) &&
        !(k == "archived_at" && h.type != "UPDATE"),
    )
    .map((k) => [HF[k] || k, hv(k, h.old[k]), hv(k, h.new[k])]);
function rHist(q) {
  const rows = (db.hist || [])
    .map((h) => {
      const t = HT[h.tbl] || [h.tbl, ""],
        name = h.new[t[1]] || h.old[t[1]] || "#" + h.id;
      return { h, t: t[0], name, d: hdiff(h) };
    })
    .filter((r) =>
      (
        r.t +
        " " +
        r.name +
        " " +
        r.h.u +
        " " +
        r.d.map((x) => x.join(" ")).join(" ")
      )
        .toLowerCase()
        .includes(q),
    );
  tbl(
    "#htbl",
    [
      ["When", (r) => r.h.t, "m"],
      ["Record", (r) => `<b>${esc(r.name)}</b><div class="mu2">${esc(r.t)}</div>`],
      [
        "Change",
        (r) =>
          `<span class="tg">${r.h.type == "ARCHIVE" ? "Archived" : r.h.type == "RESTORE" ? "Restored" : "Edited"}</span>`,
      ],
      [
        "Previous → new values",
        (r) =>
          r.d.length
            ? r.d
                .map(
                  (x) =>
                    `<div class="mu2"><b>${esc(x[0])}:</b> ${esc(x[1])} → ${esc(x[2])}</div>`,
                )
                .join("")
            : "—",
      ],
      ["By", (r) => esc(r.h.u)],
    ],
    rows,
    "No changes recorded yet.",
  );
}
/* SETTINGS = the logged-in employee's own details (name, position, email, phone, password) */
function rSet() {
  const row = (r) => `<tr><td><b>${r[0]}</b></td><td>${esc(r[1])}</td></tr>`;
  $("#setv").innerHTML =
    `<table><tbody>${[
      ["Full name", me.name],
      ["Position", me.title || "—"],
      ["Email", me.email || "—"],
      ["Mobile number", me.phone || "—"],
      ["Password", "••••••••"],
    ]
      .map(row)
      .join("")}</tbody></table>` +
    (ADM()
      ? `<h3 data-st="margin:18px 0 8px">Store settings</h3><table><tbody>${[
          ["Store name", db.set.store],
          ["Tax rate", db.set.tax + "%"],
          ["Default reorder level", db.set.reorder],
          ["Receipt footer", db.set.footer || "—"],
        ]
          .map(row)
          .join(
            "",
          )}</tbody></table><div class="bar bar-flush"><button class="b" data-a="set">Edit store settings</button></div>`
      : "");
}
function rProfile() {
  $("#profv").innerHTML =
    `<div class="pn" data-st="margin-bottom:14px">${av(me.name)}<div><b>${esc(me.name)}</b><div class="mu2">${esc(me.title || "—")} · ${esc(roleLabels(me.roles))}</div></div></div><table><tbody>${[
      ["Username", me.username],
      ["Email", me.email || "—"],
      ["Mobile number", me.phone || "—"],
      [(me.roles || []).length > 1 ? "Roles" : "Role", roleLabels(me.roles)],
      ["Account created", me.cr || "—"],
      ["Last updated", me.up || "—"],
    ]
      .map((r) => `<tr><td><b>${r[0]}</b></td><td>${esc(r[1])}</td></tr>`)
      .join("")}</tbody></table>`;
}
function editMyInfo() {
  openForm(
    "Edit my details",
    [
      { n: "name", l: "Full name", ph: "e.g. Maria Santos" },
      { n: "title", l: "Position", opt: 1, ph: "e.g. Cashier" },
      { n: "email", l: "Email address", t: "email", ph: "name@example.com" },
      { n: "phone", l: "Mobile number", t: "tel", ph: "09XXXXXXXXX" },
    ],
    { name: me.name, title: me.title, email: me.email, phone: me.phone },
    async (d) => {
      if (!(await api("update_profile", d))) return false;
      await load();
      setRole();
      show(cur);
      toast("Your details were updated");
    },
  );
}
function changeMyPw() {
  openForm(
    "Change password",
    [
      {
        n: "cur",
        l: "Current password",
        t: "password",
        ph: "Enter your current password",
      },
      {
        n: "pw",
        l: "New password",
        t: "password",
        ph: "At least 6 characters",
        v: (x) => (x.length < 6 ? "Use at least 6 characters" : ""),
      },
      {
        n: "pw2",
        l: "Confirm new password",
        t: "password",
        ph: "Re-enter the new password",
        v: (x, d) => (x !== d.pw ? "Passwords do not match" : ""),
      },
    ],
    {},
    async (d) => {
      if (!(await api("change_password", { current: d.cur, password: d.pw })))
        return false;
      toast("Password updated");
    },
  );
}
function applySet() {
  $$(".brand b").forEach((b) => (b.textContent = db.set.store));
}
function setForm() {
  openForm(
    "Store settings",
    [
      { n: "store", l: "Store name" },
      { n: "tax", l: "Tax rate (%)", t: "number", min: 0, step: ".1" },
      { n: "reorder", l: "Default reorder level", t: "number" },
      { n: "footer", l: "Receipt footer", opt: 1 },
    ],
    db.set,
    async (d) => {
      if (!(await api("save_settings", d))) return false;
      await load();
      applySet();
      show(cur);
      toast("Settings saved");
    },
  );
  const h = dlg.querySelector("h3");
  if (h)
    h.insertAdjacentHTML(
      "afterend",
      `<p class="mu">Created ${esc(db.set.cr || "—")} · Last updated ${esc(db.set.up || "—")}</p>`,
    );
}
// FIX THE STOCK COUNT
function adjust(id) {
  const p = productById(id);
  openForm(
    "Update quantity: " + p.name,
    [
      {
        n: "stock",
        l: `Counted quantity (${p.unit})`,
        t: "number",
        ph: "Enter counted quantity",
      },
    ],
    { stock: p.stock },
    async (d) => {
      if (d.stock === p.stock) return toast("Quantity unchanged");
      if (!(await api("adjust_stock", { pid: id, stock: d.stock }))) return false;
      await load();
      show(cur);
      toast(`Quantity updated: ${p.name} now ${d.stock} ${p.unit}`);
    },
  );
}
/* NOTIFICATIONS (not from a real notifications table yet) */
const seen = new Set();
const notes = () => [
  ...actv("prod")
    .filter((p) => p.stock <= p.min)
    .map((p) => ({
      id: "low" + p.id + "-" + p.stock,
      v: "products",
      t: (p.stock ? "Low stock: " : "Out of stock: ") + p.name,
      s: `${p.stock} ${p.unit} left, reorder level ${p.min}`,
    })),
]; // TODO: get these from the server later (api/notifications)
function badge() {
  const n = notes().filter((x) => !seen.has(x.id)).length;
  $("#bgc").textContent = n || "";
  $("#bgc").className = n ? "bg" : "";
}
document.addEventListener("click", (ev) => {
  if (!ev.target.closest(".rel"))
    $$(".pop").forEach((p) => p.classList.add("hide"));
});
["#eq", "#lq"].forEach((s) => ($(s).oninput = () => show(cur)));
/* LOGIN: the server checks the password against the saved hash*/
const loginTouched = new Set();
function paintLogin(inp, msg) {
  const lb = inp.closest("label");
  lb.classList.toggle("e", !!msg);
  lb.querySelector(".er").textContent = msg;
  if (msg) inp.setAttribute("aria-invalid", "true");
  else inp.removeAttribute("aria-invalid");
}
/* gives true if the field is WRONG */
function checkLogin(inp) {
  const msg =
    inp.value.trim() !== ""
      ? ""
      : inp.id == "lu"
        ? "Enter your username or email"
        : "Enter your password";
  paintLogin(inp, msg);
  return !!msg;
}
["#lu", "#lp"].forEach((s) =>
  $(s).addEventListener("input", () => {
    delete $(s).closest("label").dataset.srv;
    loginTouched.add($(s).id);
    checkLogin($(s));
  }),
);
function buildLogin() {
  $("#lu").value = "";
  $("#lp").value = "";
  loginTouched.clear();
  ["#lu", "#lp"].forEach((id) => {
    paintLogin($(id), "");
    delete $(id).closest("label").dataset.srv;
  });
  setPwVisible($("#lp"), false);
}
async function initLogin() {
  const j = await api("login_info");
  if (j) {
    db.set.store = j.store;
    applySet();
  }
  buildLogin();
}
function startUI(fresh) {
  setRole();
  $("#login").classList.add("hide");
  buildNav();
  applySet();
  if (fresh) log("Signed in");
  show(allowed("dashboard") ? "dashboard" : "sales");
}
$("#lf").onsubmit = async (ev) => {
  ev.preventDefault();
  const lb = $("#lp").closest("label"),
    er = lb.querySelector(".er"),
    user = $("#lu").value.trim(),
    pw = $("#lp").value;
  delete lb.dataset.srv;
  const badU = checkLogin($("#lu")),
    badP = checkLogin($("#lp"));
  loginTouched.add("lu").add("lp");
  if (badU || badP) {
    (badU ? $("#lu") : $("#lp")).focus();
    return;
  }
  const j = await api("login", { username: user, password: pw }, true);
  if (!j) {
    const st = (api.last || {}).status;
    er.textContent =
      st == 401 || st == 400
        ? "Incorrect username or password"
        : st == 0
          ? "Cannot reach the server. Is Apache/MySQL running?"
          : (api.last || {}).error || "Sign in failed. Try again.";
    lb.classList.add("e"); /* stays red until the user changes the password */
    lb.dataset.srv = "1";
    $("#lp").setAttribute("aria-invalid", "true");
    $("#lp").value = "";
    setPwVisible($("#lp"), false);
    $("#lp").focus();
    return;
  }
  if (await load()) startUI(true);
};
async function deactivateSelf() {
  ask(
    "Deactivate your own account? You will be signed out and an administrator will need to reactivate your account.",
    async () => {
      const result = await api("deactivate_self", {}, false);
      if (!result) return;
      toast("Your account has been deactivated.");
      me = null;
      Object.assign(db, {
        cust: [],
        cats: [],
        sup: [],
        prod: [],
        mov: [],
        sales: [],
        emp: [],
        logs: [],
      });
      document.body.className = "";
      $$(".pop").forEach((p) => p.classList.add("hide"));
      $("#login").classList.remove("hide");
      await initLogin();
    },
    "Deactivate",
  );
}
async function signOut() {
  if (!confirm("Are you sure you want to log out?")) return;

  await api("logout", {}, true);
  me = null;
  Object.assign(db, {
    cust: [],
    cats: [],
    sup: [],
    prod: [],
    mov: [],
    sales: [],
    emp: [],
    logs: [],
  });
  document.body.className = "";
  $$(".pop").forEach((p) => p.classList.add("hide"));
  $("#login").classList.remove("hide");
  initLogin();
}
function show(v) {
  if (!allowed(v)) v = allowed("dashboard") ? "dashboard" : "sales";
  cur = v;
  document.body.classList.toggle("home", v == "dashboard");
  const x = V.find((a) => a[0] == v);
  $$(".v").forEach((s) => s.classList.toggle("on", s.id == v));
  $$("#nav button, #sfn button").forEach((b) =>
    b.classList.toggle("on", b.dataset.v == v),
  );
  $("#ttl").textContent = x[1];
  $("#bc").innerHTML =
    `<span>Home</span><span>${GN[GRP[v]]}</span><span>${x[1]}</span>`;
  document.body.classList.remove("nav-open");
  $$(".pop").forEach((p) => p.classList.add("hide"));
  x[3]();
  badge();
}
document.addEventListener("click", (ev) => {
  const n = ev.target.closest("[data-v]");
  if (n) {
    show(n.dataset.v);
    scrollTo(0, 0);
    return;
  }
  const b = ev.target.closest("[data-a]");
  if (!b) return;
  const d = b.dataset;
  ({
    edit: () => edit(d.s, +d.id || 0),
    arch: () => archive(d.s, +d.id),
    restore: () => restore(d.s, +d.id),
    empst: () => setEmpStatus(+d.id, d.to),
    mv: () => (can("stock") ? mvForm(d.t) : deny()),
    newsale: () => (can("sell") ? newSale() : deny()),
    po: () => toast("Purchase orders are not enabled for this store yet"),
    sale: () => saleInfo(d.id),
    exp: () => toast("Preparing " + d.t + " export"),
    adj: () => (can("stock") ? adjust(+d.id) : deny()),
    set: () => (ADM() ? setForm() : deny()),
    read: () => {
      notes().forEach((x) => seen.add(x.id));
      badge();
      $("#np").classList.add("hide");
    },
    pw: () => toast("Password changes are managed by your administrator"),
    deactivate: deactivateSelf,
    out: signOut,
    myinfo: editMyInfo,
    mypw: changeMyPw,
  })[d.a]();
});
["#pq", "#sq", "#cq"].forEach((s) => ($(s).oninput = () => show(cur)));
["#pc", "#mf", "#pa", "#ca", "#sa", "#ea", "#cua"].forEach(
  (s) => ($(s).onchange = () => show(cur)),
);
$("#menu").onclick = () => document.body.classList.toggle("nav-open");
$("#ov").onclick = () => document.body.classList.remove("nav-open");
const root = document.documentElement;
const osDark = matchMedia("(prefers-color-scheme:dark)");
const isDark = () =>
  (root.dataset.theme || (osDark.matches ? "dark" : "light")) == "dark";
function syncThemeUI() {
  const bg = getComputedStyle(root).getPropertyValue("--bg").trim();
  const m = document.querySelector('meta[name="theme-color"]');
  if (m && bg) m.setAttribute("content", bg);
  ["#th", "#lth"].forEach(
    (s) => $(s) && $(s).setAttribute("aria-pressed", isDark()),
  );
}
function applyTheme(t, save) {
  root.dataset.theme = t;
  if (save)
    try {
      localStorage.setItem("th", t);
    } catch (_) {}
  syncThemeUI();
  if (me) show(cur); /* redraw the page so the charts use the new colors */
}
try {
  const t = localStorage.getItem("th");
  if (t == "dark" || t == "light") root.dataset.theme = t;
} catch (_) {}
syncThemeUI();
["#th", "#lth"].forEach(
  (s) => ($(s).onclick = () => applyTheme(isDark() ? "light" : "dark", true)),
);
/* use the computer's own light/dark setting if the user hasn't picked one yet */
osDark.addEventListener("change", () => {
  if (!root.dataset.theme) {
    syncThemeUI();
    if (me) show(cur);
  }
});
/* ============ DASHBOARD, STATUS, TIMELINE, NOTIFICATIONS ============ */
const CC = [
    "#2563EB",
    "#F59E0B",
    "#0D9488",
    "#16A34A",
    "#9333EA",
    "#E11D48",
    "#0891B2",
  ],
  cc = (id) => CC[id % CC.length];
const empty = (i, t, s) =>
  `<div class="em"><span class="ms">${i}</span><b>${t}</b><p>${s}</p></div>`;
const stc = (p) =>
  !p.stock
    ? ["Out of stock", "out", "#EF4444"]
    : p.stock <= p.min
      ? ["Low stock", "lo", "#F59E0B"]
      : p.stock > p.min * 6
        ? ["Overstock", "ov", "#3B82F6"]
        : ["In stock", "", "#10B981"];
const pb = (p) =>
  `<div class="pb"><i class="${stc(p)[1]}" data-st="width:${Math.min(100, Math.round((p.stock / (p.min * 3 || p.stock || 1)) * 100))}%"></i></div>`;
const stk = (p) =>
  `<div data-st="min-width:110px"><b>${p.stock}</b> <span class="mu2">${esc(p.unit)}</span>${pb(p)}</div>`;
const bdg = (p) =>
  p.arch
    ? '<span class="tg">Archived</span>'
    : `<span class="st" data-st="--c:${stc(p)[2]}">${stc(p)[0]}</span>`;
function mk2(id, cfg) {
  if (!window.Chart) return;
  ch[id] && ch[id].destroy();
  const cs = getComputedStyle(document.documentElement),
    g = (k) => cs.getPropertyValue(k).trim();
  Chart.defaults.color = g("--mu");
  Chart.defaults.borderColor = g("--ln");
  Chart.defaults.font.family = "Plus Jakarta Sans, sans-serif";
  cfg.options = { maintainAspectRatio: false, ...cfg.options };
  cfg.options.plugins = {
    tooltip: {
      backgroundColor: g("--ink"),
      titleColor: g("--bg"),
      bodyColor: g("--bg"),
      padding: 10,
      cornerRadius: 3,
      displayColors: false,
    },
    legend: { display: false },
    ...cfg.options.plugins,
  };
  cfg.g = g;
  ch[id] = new Chart($("#" + id), cfg);
}
function cnt() {
  flushStyles();
  const els = $$("#dash [data-n]"),
    still = matchMedia("(prefers-reduced-motion:reduce)").matches;
  const items = els.map((el) => {
    const to = +el.dataset.n,
      f = (v) =>
        el.dataset.f == "m" ? money(v) : Math.round(v).toLocaleString("en-PH"),
      sp = document.createElement("span");
    sp.className = "nv";
    sp.textContent = f(to);
    el.textContent = "";
    el.append(sp);
    return { sp, to, f, last: "" };
  });
  // NUMBER COUNTING ANIMATION (the numbers count up)
  items.forEach((i) => {
    i.sp.style.minWidth = Math.ceil(i.sp.getBoundingClientRect().width) + "px";
  });
  if (still) return;
  const D = 1500,
    T0 = performance.now() + 280,
    ease = (k) => 1 - Math.pow(1 - k, 4);
  items.forEach((i) => (i.sp.textContent = i.f(0)));
  (function tick(t) {
    let live = false;
    items.forEach((i) => {
      if (!i.sp.isConnected) return;
      const k = Math.min(1, Math.max(0, (t - T0) / D)),
        txt = i.f(i.to * ease(k));
      if (txt !== i.last) {
        i.sp.textContent = txt;
        i.last = txt;
      }
      if (k < 1) live = true;
    });
    if (live) requestAnimationFrame(tick);
  })(performance.now());
}
// DASHBOARD (THE COMMAND CENTER)
const AVC = ["#2563EB", "#EA580C", "#0D9488", "#9333EA", "#E11D48", "#0891B2"],
  ini = (n) =>
    n
      .split(" ")
      .filter((w, i, a) => !i || i == a.length - 1)
      .map((w) => w[0])
      .join(""),
  av = (n, s) =>
    `<span class="av ${s || ""}" data-st="background:${AVC[[...n].reduce((a, c) => a + c.charCodeAt(0), 0) % 6]}">${ini(n)}</span>`;
const PAY = {
    Cash: "var(--k-in)",
    GCash: "#0A64F0",
    Maya: "#0EA45B",
    "Bank transfer": "#9333EA",
    "Charge account": "#EA580C",
  },
  CI = [
    "foundation",
    "construction",
    "carpenter",
    "plumbing",
    "bolt",
    "format_paint",
    "handyman",
  ],
  ci = (id) => CI[(id - 1) % CI.length],
  fd = (d) =>
    new Date(d.replace(" ", "T")).toLocaleDateString("en-PH", {
      month: "short",
      day: "numeric",
    });
const wh = (t, s, v) =>
  `<div class="wh"><div><h3>${t}</h3><div class="sub">${s}</div></div>${v && allowed(v) ? `<a class="va" data-v="${v}">View all</a>` : ""}</div>`;
function rHome() {
  const PR = actv("prod"),
    low = PR.filter((p) => p.stock <= p.min),
    out = PR.filter((p) => !p.stock).length,
    ok = PR.length - low.length,
    hs = PR.length ? Math.round((ok / PR.length) * 100) : 0;
  const rev = db.sales.reduce((a, s) => a + total(s), 0),
    val = PR.reduce((a, p) => a + p.stock * p.price, 0),
    rs = low.reduce(
      (a, p) => a + Math.max(0, p.min * 2 - p.stock) * p.price,
      0,
    );
  const day = {};
  db.sales.forEach((s) => {
    const d = s.date.slice(0, 10);
    day[d] = (day[d] || 0) + total(s);
  });
  const dk = Object.keys(day).sort().slice(-7),
    dv = dk.map((d) => day[d]),
    ld = dv[dv.length - 1] || 0,
    pv = dv.slice(0, -1),
    pa = pv.length ? pv.reduce((a, b) => a + b, 0) / pv.length : 0,
    dl = pa ? Math.round(((ld - pa) / pa) * 100) : 0,
    wk = dv.reduce((a, b) => a + b, 0);
  const mx = Math.max(...dv, 1),
    pth = dv
      .map(
        (v, i) =>
          (i ? "L" : "M") +
          ((i / Math.max(dv.length - 1, 1)) * 260).toFixed(1) +
          " " +
          (64 - (v / mx) * 56).toFixed(1),
      )
      .join("");
  const tx = db.sales.length,
    tk = tx ? rev / tx : 0,
    ts = {};
  db.sales.forEach((s) =>
    s.items.forEach((i) => (ts[i.pid] = (ts[i.pid] || 0) + i.qty * i.price)),
  );
  const top = Object.entries(ts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5),
    tm = top[0] ? top[0][1] : 1;
  const cv = actv("cats").map((c) => [
      c,
      PR.filter((p) => p.cat === c.id).reduce(
        (a, p) => a + p.stock * p.price,
        0,
      ),
    ]),
    cu = actv("cats").map((c) => [
      c,
      PR.filter((p) => p.cat === c.id).reduce((a, p) => a + p.stock, 0),
    ]);
  const h = new Date().getHours(),
    gr = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening",
    fn = me.name.split(" ").slice(0, -1).join(" ") || me.name;
  const qa = [
    [can("sell"), 'data-a="newsale"', "point_of_sale", "New sale"],
    [can("stock"), 'data-a="mv" data-t="IN"', "add_box", "Receive stock"],
    [
      can("manage"),
      'data-a="edit" data-s="prod"',
      "inventory_2",
      "Add product",
    ],
    [allowed("reports"), 'data-v="reports"', "insights", "View reports"],
    [
      allowed("movements"),
      'data-v="movements"',
      "swap_vert",
      "Stock movements",
    ],
  ]
    .filter((a) => a[0])
    .slice(0, 4);
  const mv = db.mov.slice(-6).reverse(),
    lg = db.logs.slice(-7).reverse();
  /* The HTML of each dashboard card is saved here with a name, then we put them together in order below. */
  const hero = `<div class="hr"><div><div class="eb">${new Date().toLocaleDateString("en-PH", { weekday: "long", month: "long", day: "numeric" })}</div><h2>${gr}, ${esc(fn)}!</h2><div class="rl">${esc(roleLabels(me.roles))} · Stock Keeper</div><p data-st="margin-top:12px">${low.length ? `<b>${low.length} item${low.length > 1 ? "s" : ""}</b> need restocking${out ? `, ${out} already out of stock` : ""}. ` : "All stock levels are healthy. "}${tx} sales logged so far, worth ${money(rev)}.</p><div class="hq">${qa.map((a, i) => `<button class="hb${i ? "" : " o"}" ${a[1]}><span class="ms">${a[2]}</span>${a[3]}</button>`).join("")}</div></div>`;

  const revenueCard = `<div class="rv"><div class="eb">Revenue · last 7 days</div><b data-n="${wk}" data-f="m">0</b><div class="rvs"><span class="dl ${dl < 0 ? "dn" : ""}"><span class="ms">${dl < 0 ? "trending_down" : "trending_up"}</span>${Math.abs(dl)}%</span><span>Latest day ${money(ld)} vs daily avg</span></div>${dv.length > 1 ? `<svg viewBox="0 0 260 72" preserveAspectRatio="none" width="100%" height="72"><defs><linearGradient id="sg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#FBBF24" stop-opacity=".45"/><stop offset="1" stop-color="#FBBF24" stop-opacity="0"/></linearGradient></defs><path d="${pth} L260 72 L0 72Z" fill="url(#sg)"/><path d="${pth}" fill="none" stroke="#FBBF24" stroke-width="2.5" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>` : ""}</div></div>`;

  const inventoryTile = `<div class="s4 tile" data-st="background:linear-gradient(135deg,#1E4FBF,#3B82F6)"><div class="t1"><span class="ms">warehouse</span>Inventory value</div><b data-n="${val}" data-f="m">0</b><div class="t2">${PR.length} products across ${actv("cats").length} categories</div><div class="sb">${cv.map((c) => `<i title="${esc(c[0].name)}" data-st="flex:${c[1] || 1};background:${cc(c[0].id)}"></i>`).join("")}</div></div>`;

  const restockTile = `<div class="s4 tile" data-st="background:linear-gradient(135deg,#C2410C,#F59E0B)"><div class="t1"><span class="ms">warning</span>Needs restocking</div><b data-n="${low.length}">0</b><div class="t2">Est. restock cost ${money(rs)}</div><button class="hb" data-v="products" data-st="margin-top:14px">Review items</button></div>`;

  const salesTile = `<div class="s4 tile" data-st="background:linear-gradient(135deg,#0F766E,#14B8A6)"><div class="t1"><span class="ms">receipt_long</span>Sales performance</div><b data-n="${tx}">0</b><div class="t2">Avg. ticket ${money(tk)}${top[0] ? ` · Top: ${esc(productById(+top[0][0]).name)}` : ""}</div></div>`;

  const trendCard = `<div class="s8 w">${wh("Sales trend", "Daily revenue, last 7 days of activity", "reports")}<div class="cv"><canvas id="h1"></canvas></div></div>`;

  const healthCard = `<div class="s4 w">${wh("Inventory health", ok + " of " + PR.length + " products above reorder level")}<div class="hl"><canvas id="h2"></canvas><div class="ct"><div><b>${hs}%</b><span class="mu2">healthy</span></div></div></div><div class="lgd"><span><span class="cd" data-st="--c:#10B981"></span>${ok} healthy</span><span><span class="cd" data-st="--c:#F59E0B"></span>${low.length - out} low</span><span><span class="cd" data-st="--c:#EF4444"></span>${out} out</span></div></div>`;

  const restockList = `<div class="s5 w">${wh("Needs restocking", "Lowest stock first", "products")}${
    low.length
      ? low
          .sort((a, b) => a.stock / (a.min || 1) - b.stock / (b.min || 1))
          .slice(0, 5)
          .map(
            (p) =>
              `<div class="li"><span class="ch" data-st="--c:${cc(p.cat)}"><span class="ms">${ci(p.cat)}</span></span><div><b>${esc(p.name)}</b><div class="mu2">${p.stock} ${esc(p.unit)} left · reorder at ${p.min} · ${esc(nameOf("sup", p.sup))}</div>${pb(p)}</div>${can("manage") || can("stock") ? '<button class="b s" data-a="po">Create PO</button>' : ""}</div>`,
          )
          .join("")
      : empty(
          "verified",
          "Stock is healthy",
          "Nothing is below its reorder level.",
        )
  }</div>`;

  const recentSales = `<div class="s7 w">${wh("Recent sales", "Click a sale to open its receipt", "sales")}${
    db.sales
      .slice(-5)
      .reverse()
      .map(
        (s) =>
          `<div class="li" data-a="sale" data-id="${s.id}"><span class="ch" data-st="--c:${PAY[s.pay] || "#2563EB"}">${ini(s.cust.replace(/^(Engr\.|Dra\.|Aling|Mang|Kuya|Ate)\s/, ""))}</span><div><b>${esc(s.cust)}</b><div class="mu2">${s.id} · ${s.items.length} item${s.items.length > 1 ? "s" : ""} · ${esc(s.by || "—")}</div></div><div data-st="text-align:right"><b class="m">${money(total(s))}</b><div><span class="st" data-st="--c:${PAY[s.pay] || "#2563EB"}">${esc(s.pay)}</span></div></div></div>`,
      )
      .join("") ||
    empty("receipt_long", "No sales yet", "Completed sales will appear here.")
  }</div>`;

  const movementsCard = `<div class="s6 w">${wh("Inventory movements", "Latest stock in and out", "movements")}${mv.map((m) => `<div class="li"><span class="ch" data-st="--c:${m.type == "IN" ? "#10B981" : "#EF4444"}"><span class="ms">${m.type == "IN" ? "south_west" : "north_east"}</span></span><div><b>${esc(productById(m.pid).name || "—")}</b><div class="mu2">${esc(m.note)} · ${esc(m.by || "—")}</div></div><div data-st="text-align:right"><b class="m" data-st="color:${m.type == "IN" ? "#10B981" : "#EF4444"}">${m.type == "IN" ? "+" : "−"}${m.qty}</b><div class="mu2">${fd(m.date)}</div></div></div>`).join("") || empty("swap_vert", "No movements yet", "Stock in and out will appear here.")}</div>`;

  const activityCard = `<div class="s6 w">${wh("Team activity", "What your staff has been doing", "logs")}<div class="feed">${lg.map((l) => `<div class="fi">${av(l.u)}<div><b>${esc(l.u)}</b> <span class="mu2">· ${ROLE[l.r]}</span><div>${esc(l.a)}</div></div><span class="mu2">${fd(l.t)}, ${l.t.slice(11)}</span></div>`).join("")}</div></div>`;

  const topProducts = `<div class="s6 w">${wh("Top-selling products", "By revenue")}${top.map((t) => `<div class="li"><div data-st="flex:1"><div data-st="display:flex;justify-content:space-between"><b>${esc(productById(+t[0]).name)}</b><span class="m">${money(t[1])}</span></div><div class="tb"><i data-st="--c:${cc(productById(+t[0]).cat)};width:${Math.round((t[1] / tm) * 100)}%"></i></div></div></div>`).join("") || empty("trending_up", "No sales data yet", "Top sellers appear after the first sale.")}</div>`;

  const categoryStock = `<div class="s6 w">${wh("Stock by category", "Units on hand")}<div class="cv"><canvas id="h3"></canvas></div></div>`;

  $("#dash").innerHTML =
    `<div class="dg">` +
    [
      hero,
      revenueCard,
      inventoryTile,
      restockTile,
      salesTile,
      trendCard,
      healthCard,
      restockList,
      recentSales,
      movementsCard,
      activityCard,
      topProducts,
      categoryStock,
    ].join("\n") +
    `</div>`;
  cnt();
  const ln = getComputedStyle(document.documentElement)
      .getPropertyValue("--ln")
      .trim(),
    tk2 = (v) => "₱" + (v >= 1000 ? v / 1000 + "k" : v);
  mk2("h1", {
    type: "line",
    data: {
      labels: dk.map((d) => fd(d)),
      datasets: [
        {
          data: dv.map(Math.round),
          borderColor: "#3B82F6",
          backgroundColor: (c) => {
            const g = c.chart.ctx.createLinearGradient(0, 0, 0, 260);
            g.addColorStop(0, "rgba(59,130,246,.35)");
            g.addColorStop(1, "rgba(59,130,246,0)");
            return g;
          },
          fill: true,
          tension: 0.4,
          borderWidth: 3,
          pointRadius: 4,
          pointHoverRadius: 7,
          pointBackgroundColor:
            getComputedStyle(document.documentElement)
              .getPropertyValue("--pn")
              .trim() || "#fff",
          pointBorderColor: "#3B82F6",
          pointBorderWidth: 2,
        },
      ],
    },
    options: {
      scales: {
        x: { grid: { display: false } },
        y: {
          beginAtZero: true,
          border: { display: false },
          grid: { color: ln },
          ticks: { callback: tk2 },
        },
      },
    },
  });
  mk2("h2", {
    type: "doughnut",
    data: {
      labels: ["Healthy", "Low", "Out"],
      datasets: [
        {
          data: [ok, low.length - out, out],
          backgroundColor: ["#10B981", "#F59E0B", "#EF4444"],
          borderWidth: 0,
          spacing: 4,
          borderRadius: 6,
        },
      ],
    },
    options: { cutout: "76%" },
  });
  mk2("h3", {
    type: "bar",
    data: {
      labels: cu.map((c) => c[0].name),
      datasets: [
        {
          data: cu.map((c) => c[1]),
          backgroundColor: cu.map((c) => cc(c[0].id)),
          borderRadius: 8,
          barThickness: 16,
        },
      ],
    },
    options: {
      indexAxis: "y",
      scales: {
        x: { border: { display: false }, grid: { color: ln } },
        y: { grid: { display: false } },
      },
    },
  });
}
/* ACTIVITY TIMELINE */
function tlHtml(L) {
  if (!L.length)
    return empty(
      "history",
      "No activity matches",
      "Try a different search term.",
    );
  let d = "";
  return (
    '<div class="tlw">' +
    L.map((l) => {
      const k = /^Sale/.test(l.a)
        ? ["receipt_long", "var(--k-sale)"]
        : /^Stock|^Quantity/.test(l.a)
          ? ["swap_vert", "var(--k-stock)"]
          : /deactivated/i.test(l.a)
            ? ["person_off", "var(--k-del)"]
            : /activated/i.test(l.a)
              ? ["person_check", "var(--k-add)"]
              : /archived/.test(l.a)
                ? ["inventory_2", "var(--k-stock)"]
                : /restored/.test(l.a)
                  ? ["unarchive", "var(--k-add)"]
                  : /deleted/.test(l.a)
                    ? ["delete", "var(--k-del)"]
                    : /added|created/i.test(l.a)
                      ? ["add_circle", "var(--k-add)"]
                      : /Signed/.test(l.a)
                        ? ["login", "var(--k-in)"]
                        : ["edit", "var(--k-edit)"];
      const day = l.t.slice(0, 10),
        hd = day != d ? `<div class="tld">${(d = day)}</div>` : "";
      return (
        hd +
        `<div class="tli"><span class="ti" data-st="--c:${k[1]}"><span class="ms">${k[0]}</span></span><div><b>${esc(l.a)}</b><div class="mu2">${esc(l.u)} · ${ROLE[l.r]} · ${l.t.slice(11)}</div></div></div>`
      );
    }).join("") +
    "</div>"
  );
}
/* NOTIFICATION CENTER */
const NM = {
  low: ["warning", "var(--k-stock)", "Inventory"],
  out: ["error", "var(--k-del)", "Inventory"],
  inv: ["request_quote", "var(--k-sale)", "Finance"],
  po: ["local_shipping", "var(--k-add)", "Procurement"],
};
$("#bell").onclick = () => {
  const p = $("#np"),
    ns = notes().map((n, i) => ({
      ...n,
      m: n.t.startsWith("Out") ? NM.out : NM[n.id.replace(/\d.*/, "")],
      ago: i * 2 + 1 + "h ago",
    }));
  const gs = ["Inventory", "Finance", "Procurement"]
    .map((g) => [g, ns.filter((n) => n.m[2] == g)])
    .filter((g) => g[1].length);
  p.innerHTML =
    `<div class="nh"><span>Notifications</span><a data-a="read" data-st="color:var(--ac);cursor:pointer;font-weight:600">Mark all read</a></div>` +
    (gs
      .map(
        (g) =>
          `<div class="ng2">${g[0]}</div>` +
          g[1]
            .map(
              (n) =>
                `<div class="nt" data-v="${n.v}" data-st="--c:${n.m[1]}"><span class="ti"><span class="ms">${n.m[0]}</span></span><div data-st="flex:1"><div data-st="font-weight:${seen.has(n.id) ? 400 : 700}">${esc(n.t)}</div><div class="mu2">${esc(n.s)}</div></div><span class="mu2">${n.ago}</span></div>`,
            )
            .join(""),
      )
      .join("") ||
      empty(
        "notifications_off",
        "You are all caught up",
        "New alerts will show up here.",
      ));
  p.classList.toggle("hide");
};
/* Start of the app: if the user is still logged in, go straight in. If not, show the login screen */
(async () => {
  if (await load(true)) startUI(false);
  else initLogin();
})();