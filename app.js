const paint = (n) => {
  if (n.nodeType !== 1) return;
  [n, ...n.querySelectorAll("[data-st]")].forEach((x) => {
    if (x.dataset && x.dataset.st !== undefined) {
      x.style.cssText = x.dataset.st;
      x.removeAttribute("data-st");
    }
  });
};
const mo = new MutationObserver((ms) =>
  ms.forEach((m) => m.addedNodes.forEach(paint)),
);
mo.observe(document.documentElement, { childList: true, subtree: true });
const flushStyles = () =>
  mo.takeRecords().forEach((m) => m.addedNodes.forEach(paint));

/* ============ HELPERS ============ */
const $ = (s) => document.querySelector(s),
  $$ = (s) => [...document.querySelectorAll(s)];
const e = (s) =>
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

// ============ PASSWORD VISIBILITY TOGGLE ============
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
    ev.preventDefault(); /* keep focus and caret in the field */
});
document.addEventListener("click", (ev) => {
  const b = ev.target.closest(".pwt");
  if (!b) return;
  const input = b.parentElement.querySelector("input");
  setPwVisible(input, input.type === "password");
});

/* ============ DATA  ============ */
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
const P = (id) => db.prod.find((p) => p.id === id) || {};
const total = (s) => s.items.reduce((a, i) => a + i.qty * i.price, 0);
const nm = (l, id) => (db[l].find((x) => x.id === id) || { name: "—" }).name;

/* Calls api.php. Returns the JSON on success, or null (and shows a toast) on failure. */
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
/* Reloads every table from the database and refreshes the session. */
async function load(quiet) {
  const j = await api("bootstrap", null, quiet);
  if (!j) return false;
  me = j.user;
  Object.assign(db, j.data);
  return true;
}

/* ============ UI PRIMITIVES ============ */
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
/* rc (optional) returns an extra class name for a row, e.g. "arch" for archived records. */
function tbl(el, cols, rows, empty, rc) {
  $(el).innerHTML = rows.length
    ? `<table><thead><tr>${cols.map((c) => `<th>${c[0]}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr${rc && rc(r) ? ` class="${rc(r)}"` : ""}>${cols.map((c) => `<td class="${c[2] || ""}">${c[1](r)}</td>`).join("")}</tr>`).join("")}</tbody></table>`
    : `<div class="em"><span class="ms">inbox</span><b>${empty || "Nothing here yet"}</b><p>Records you add will appear here.</p></div>`;
}
/* Archive helpers: records are never deleted, only flagged arch = true. */
const actv = (l) => db[l].filter((x) => !x.arch);
const arf = (sel) => {
  const v = $(sel).value;
  return (x) => v == "all" || (v == "arch" ? !!x.arch : !x.arch);
};
const archRow = (x) => (x.arch ? "arch" : "");
/* Added / updated (and archived) dates shown on every record list */
const dts = (x) =>
  `<div class="mu2">Added ${e(x.cr || "—")}</div><div class="mu2">Updated ${e(x.up || "—")}</div>` +
  (x.ar ? `<div class="mu2">Archived ${e(x.ar)}</div>` : "");
const archTag = (x) => (x.arch ? ' <span class="tg">Archived</span>' : "");
const archEmpty = (sel, what) =>
  $(sel).value == "arch" ? `No archived ${what}.` : null;
const acts = (s, id) => {
  if (!can("manage")) return "";
  const it = db[S[s].k].find((x) => x.id === id);
  // Edit: administrators and managers. Archive / Restore: administrators only.
  return it && it.arch
    ? can("archive")
      ? `<button class="b s" data-a="restore" data-s="${s}" data-id="${id}">Restore</button>`
      : ""
    : `<button class="b s" data-a="edit" data-s="${s}" data-id="${id}">Edit</button>` +
        (can("archive")
          ? ` <button class="b s" data-a="arch" data-s="${s}" data-id="${id}">Archive</button>`
          : "");
};
/* Employee actions: Edit plus an Active/Inactive toggle (employees are never deleted or archived). */
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

/* Generic modal form builder with validation. */
const EMAIL_RE =
  /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const PH_RE = /^09\d{9}$/; /* 09XXXXXXXXX, exactly 11 digits */
function openForm(title, fs, vals, save) {
  const ph = (f) => (f.ph ? ` placeholder="${e(f.ph)}"` : "");
  dlg.innerHTML = `<form novalidate><h3>${title}</h3>${fs.map((f) => `<label>${f.l}${f.t == "select" ? `<select name="${f.n}">${f.ph ? `<option value="" disabled selected hidden>${e(f.ph)}</option>` : ""}${f.o.map((o) => `<option value="${o[0]}">${e(o[1])}</option>`).join("")}</select>` : f.t == "password" ? `<span class="pw"><input name="${f.n}" type="password"${ph(f)}>${PWBTN}</span>` : `<input name="${f.n}" type="${f.t || "text"}"${f.ro ? " readonly" : ""}${f.t == "number" ? ` min="${f.min ?? 0}" step="${f.step || 1}"` : ""}>`}${f.h ? `<small class="hint">${f.h}</small>` : ""}<small class="er"></small></label>`).join("")}<div class="ft"><button type="button" class="b" data-x>Cancel</button><button class="b p">Save</button></div></form>`;
  const fm = dlg.querySelector("form");
  fs.forEach((f) => {
    let v = vals[f.n];
    if (v === undefined) return;
    if (f.t == "tel") v = v == "—" ? "" : String(v).replace(/[\s()-]/g, "");
    fm.elements[f.n].value = v;
  });
  const read = () => {
    const d = {};
    fs.forEach((f) => {
      const x = fm.elements[f.n].value.trim();
      d[f.n] = f.t == "number" || f.num ? (x === "" ? NaN : +x) : x;
    });
    return d;
  };
  const lab = (f) => fm.elements[f.n].closest("label");
  /* A field becomes "touched" the first time the user types in it or leaves it.
     Touched fields are re-validated on every keystroke / change and stay red
     until they satisfy their rules. Untouched fields are only flagged on submit. */
  const touched = new Set();
  /* returns true when the field is INVALID, and paints/clears the red state */
  const check = (f, d) => {
    const x = d[f.n],
      empty = x === "" || Number.isNaN(x);
    let m = "";
    if (bad) m = "Enter a valid number";
    else if (empty && !f.opt) m = "This field is required";
    else if (!empty && f.t == "number" && x < (f.min ?? 0))
      m = "Enter at least " + (f.min ?? 0);
    else if (!empty && f.t == "number" && !f.step && !Number.isInteger(x))
      m = "Enter a whole number";
    else if (!empty && f.t == "email" && !EMAIL_RE.test(x))
      m = "Enter a valid email address (e.g. name@example.com)";
    else if (!empty && f.t == "tel" && !PH_RE.test(x))
      m = "Enter an 11-digit mobile number starting with 09 (09XXXXXXXXX)";
    else if (!empty && f.v) m = f.v(x, d) || "";
    lab(f).classList.toggle("e", !!m);
    lab(f).querySelector(".er").textContent = m;
    if (m) el.setAttribute("aria-invalid", "true");
    else el.removeAttribute("aria-invalid");
    return !!m;
  };
  const fieldOf = (ev) => fs.find((x) => x.n == ev.target.name);
  /* re-check every touched field, so dependent rules update too
     (e.g. picking another product re-checks the quantity; editing the password re-checks its confirmation) */
  const revalidate = () => {
    const d = read();
    fs.forEach((f) => touched.has(f.n) && check(f, d));
  };
  let cancelling = false; /* don't let a blur-triggered error shift the Cancel button out from under the click */
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
  fm.onsubmit = (ev) => {
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
    dlg.close();
    save(d);
  };
  dlg.showModal();
}

/* ============ CRUD: products, categories, suppliers ============ */
const S = {
  prod: {
    k: "prod",
    t: "Product",
    f: () => [
      {
        n: "sku",
        l: 'SKU <span class="auto" title="Auto-generated">*</span>',
        ro: 1,
        h: '<span class="auto">*</span> Auto-generated from the category. It cannot be edited.',
      },
      { n: "name", l: "Product name", ph: "e.g. Portland Cement 40 kg" },
      {
        n: "cat",
        l: "Category",
        t: "select",
        num: 1,
        ph: "Select a category",
        o: actv("cats").map((c) => [c.id, c.name]),
      },
      {
        n: "sup",
        l: "Supplier",
        t: "select",
        num: 1,
        ph: "Select a supplier",
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
      { n: "unit", l: "Unit (pcs, kg, roll)", ph: "e.g. bag, pcs, kg" },
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
      { n: "city", l: "City / Province", ph: "e.g. Calamba City, Laguna" },
      { n: "phone", l: "Phone", t: "tel", ph: "09XXXXXXXXX" },
      { n: "email", l: "Email", t: "email", ph: "name@company.com" },
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
        ? { min: db.set.reorder, sku: nextSku((db.cats[0] || {}).id) }
        : {};
  const fs = c.f();
  if (s == "emp" && !id)
    fs.push({
      n: "pw",
      l: "Password",
      t: "password",
      ph: "At least 6 characters",
      v: (x) => (x.length < 6 ? "Use at least 6 characters" : ""),
    });
  openForm((id ? "Edit " : "Add ") + c.t.toLowerCase(), fs, it, async (d) => {
    const j = await api("save_" + API[s], { ...d, id });
    if (!j) return;
    await load();
    show(cur);
    toast(c.t + (id ? " updated: " : " added: ") + d.name);
  });
  if (s == "prod" && !id)
    dlg.querySelector('[name="cat"]').onchange = (ev) =>
      (dlg.querySelector('[name="sku"]').value = nextSku(+ev.target.value));
}
/* Archive instead of delete: the record stays in the database and can be restored. */
function archive(s, id) {
  if (!can("archive")) return deny();
  const c = S[s],
    it = db[c.k].find((x) => x.id === id);
  const why =
    s == "cat" && actv("prod").some((p) => p.cat === id)
      ? "Archive or move the active products in this category first"
      : s == "sup" && actv("prod").some((p) => p.sup === id)
        ? "Archive or move the active products from this supplier first"
        : "";
  if (why) return toast(why, "bad");
  const note =
    s == "prod"
      ? "It will be hidden from sales, stock forms and reports."
      : s == "cust"
        ? "It will no longer be offered when making a sale. Past sales keep the customer name."
        : "It will be hidden from lists and forms.";
  ask(
    `Archive <b>${e(it.name)}</b>? ${note} Nothing is deleted. You can restore it any time by switching the filter to Archived.`,
    async () => {
      if (!(await api("archive_" + API[s], { id }))) return;
      await load();
      show(cur);
      toast(c.t + " archived: " + it.name);
    },
    "Archive",
  );
}
/* Switch an employee between Active and Inactive. Inactive accounts cannot sign in; records are kept. */
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
    it.role == "admin" &&
    db.emp.filter((u) => u.role == "admin" && u.status == "Active").length < 2
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
    `Deactivate <b>${e(it.name)}</b>? They will no longer be able to sign in. Their records and history are kept, and you can activate the account again at any time.`,
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

/* ============ VIEW RENDERERS ============ */
const saleCols = [
  ["Receipt", (s) => `<b>${s.id}</b>`, "m"],
  ["Date", (s) => s.date, "m"],
  ["Customer", (s) => e(s.cust)],
  ["Lines", (s) => s.items.length],
  ["Cashier", (s) => e(s.by || "—")],
  ["Payment", (s) => e(s.pay)],
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
          `<option value="${c.id}">${e(c.name)}${c.arch ? " (archived)" : ""}</option>`,
      )
      .join("");
  sel.value = cur0;
  const q = $("#pq").value.toLowerCase(),
    c = +sel.value;
  const rows = db.prod.filter(
    (p) =>
      (!c || p.cat === c) &&
      arf("#pa")(p) &&
      (p.name + p.sku).toLowerCase().includes(q),
  );
  tbl(
    "#ptbl",
    [
      ["SKU", (p) => e(p.sku), "m"],
      [
        "Product",
        (p) =>
          `<div class="pn"><span class="ch" data-st="--c:${cc(p.cat)}"><span class="ms">${ci(p.cat)}</span></span><b>${e(p.name)}</b></div>`,
      ],
      [
        "Category",
        (p) =>
          `<span class="cd" data-st="--c:${cc(p.cat)}"></span>${e(nm("cats", p.cat))}`,
      ],
      ["Supplier", (p) => e(nm("sup", p.sup))],
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
      ["Category", (c) => `<b>${e(c.name)}</b>${archTag(c)}`],
      ["Description", (c) => e(c.desc || "")],
      [
        "Products",
        (c) => actv("prod").filter((p) => p.cat === c.id).length,
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
          `<div class="pn"><span class="ch" data-st="--c:${cc(s.id)}"><span class="ms">local_shipping</span></span><b>${e(s.name)}</b>${archTag(s)}</div>`,
      ],
      ["Contact", (s) => e(s.contact)],
      ["Barangay", (s) => e(s.brgy || "—")],
      ["City", (s) => e(s.city || "—")],
      ["Phone", (s) => e(s.phone), "m"],
      ["Email", (s) => e(s.email)],
      [
        "Products",
        (s) => actv("prod").filter((p) => p.sup === s.id).length,
        "m",
      ],
      ["", (s) => acts("sup", s.id), "act"],
    ],
    db.sup.filter(arf("#sa")),
    archEmpty("#sa", "suppliers") || "No suppliers yet.",
    archRow,
  );
}
function rMov() {
  const f = $("#mf").value;
  tbl(
    "#mtbl",
    [
      ["Date", (m) => m.date, "m"],
      ["Product", (m) => e(P(m.pid).name || "—")],
      [
        "Type",
        (m) =>
          `<span class="tg ${m.type == "IN" ? "ok" : "bd"}">${m.type == "IN" ? "Stock in" : "Stock out"}</span>`,
      ],
      ["Qty", (m) => (m.type == "IN" ? "+" : "−") + m.qty, "m"],
      ["Reference / reason", (m) => e(m.note)],
      ["Handled by", (m) => (m.by ? av(m.by, "sm") + " " + e(m.by) : "—")],
    ],
    db.mov.filter((m) => !f || m.type == f).reverse(),
  );
}
function rSales() {
  const q = $("#sq").value.toLowerCase();
  tbl(
    "#stbl2",
    saleCols,
    db.sales.filter((s) => (s.id + s.cust).toLowerCase().includes(q)).reverse(),
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
      ["SKU", (p) => e(p.sku), "m"],
      ["Product", (p) => e(p.name)],
      ["Category", (p) => e(nm("cats", p.cat))],
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
    const d = s.date.slice(5, 10);
    day[d] = (day[d] || 0) + total(s);
    pay[s.pay] = pay[s.pay] || [0, 0];
    pay[s.pay][0]++;
    pay[s.pay][1] += total(s);
  });
  mk(
    "c3",
    "bar",
    Object.keys(day),
    Object.values(day).map((v) => Math.round(v)),
    "Revenue (₱)",
  );
  tbl(
    "#rpay",
    [
      ["Method", (r) => e(r[0])],
      ["Transactions", (r) => r[1][0], "m"],
      ["Revenue", (r) => money(r[1][1]), "m"],
    ],
    Object.entries(pay),
  );
}

/* ============ INVENTORY MOVEMENTS ============ */
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
          out && x > P(d.pid).stock ? `Only ${P(d.pid).stock} on hand` : "",
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
        return;
      await load();
      show(cur);
      toast(`${out ? "Stock out" : "Stock in"}: ${d.qty} × ${P(d.pid).name}`);
    },
  );
}

/* ============ SALES ============ */
function newSale() {
  openForm(
    "New sale",
    [
      { n: "cust", l: "Customer", ph: "e.g. Walk-in or customer name" },
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
          x > P(d.pid).stock ? `Only ${P(d.pid).stock} in stock` : "",
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
        cid: d.cid,
        pid: d.pid,
        qty: d.qty,
        pay: d.pay,
      });
      if (!j) return;
      await load();
      show(cur);
      toast("Sale " + j.receipt + " saved");
    },
  );
}
function saleInfo(id) {
  const s = db.sales.find((x) => x.id == id);
  dlg.innerHTML = `<h3>Receipt ${s.id}</h3><p class="mu" data-st="margin:0 0 12px">${s.date} · ${e(s.cust)} · ${e(s.pay)}</p><div class="tw"><table><thead><tr><th>Item</th><th>Qty</th><th>Price</th><th>Subtotal</th></tr></thead><tbody>${s.items.map((i) => `<tr><td>${e(i.name || P(i.pid).name || "—")}</td><td class="m">${i.qty}</td><td class="m">${money(i.price)}</td><td class="m">${money(i.qty * i.price)}</td></tr>`).join("")}</tbody></table></div><h3 data-st="margin-top:14px">Total ${money(total(s))}</h3><p class="mu" data-st="margin:4px 0 0">Includes ${db.set.tax}% VAT: ${money((total(s) * db.set.tax) / (100 + db.set.tax))} · Cashier: ${e(s.by || "—")}</p><div class="ft"><button class="b p" data-x>Close</button></div>`;
  dlg.showModal();
}

/* ============ NAVIGATION, THEME, EVENTS ============ */
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
// ============ ROLES, AUTH, EMPLOYEES, LOGS, SETTINGS ============
V.push(
  ["customers", "Customers", "groups", rCust],
  ["employees", "Employees", "badge", rEmp],
  ["logs", "Activity logs", "history", rLogs],
  ["settings", "Settings", "settings", rSet],
  ["profile", "Profile", "account_circle", rProfile],
);
// LOAD THE ROLES
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
/* Clear responsibilities per role (shown on the Employees page) */
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
const can = (k) => !!me && CAN[k].includes(me.role);
let me = null;
const ADM = () => me && me.role == "admin";
// PERMISSION MAP, USED TO FILTER WHAT ROLES CAN DO CERTAIN THINGS
const allowed = (v) =>
  v == "profile" ||
  v == "settings" ||
  !VIEWS[me.role] ||
  VIEWS[me.role].includes(v);
const deny = () => toast("Permission denied: your role cannot do this", "bad");
S.emp = {
  k: "emp",
  t: "Employee",
  f: () => [
    { n: "name", l: "Full name", ph: "e.g. Maria Santos" },
    { n: "title", l: "Position", ph: "e.g. Cashier" },
    {
      n: "role",
      l: "Role",
      t: "select",
      ph: "Select a role",
      o: Object.entries(ROLE),
    },
    { n: "phone", l: "Phone", t: "tel", ph: "09XXXXXXXXX" },
  ],
};
function log(a) {
  if (!me) return;
  db.logs.push({ t: now(), u: me.name, r: me.role, a });
  api("log", { text: a }, true); // saved to activity_logs
}
// Sidebar is grouped and filtered by role
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
    )}</span><div><b>${e(me.name)}</b><small>${ROLE[me.role]}</small></div>`;
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
/* SIGN UP - FRONT END ONLY [REMINDER TO ADD BACKEND AUTHORIZATION FOR THIS FEATURE] */
function signUp() {
  openForm(
    "Create account",
    [
      { n: "name", l: "Full name", ph: "e.g. Maria Santos" },
      { n: "title", l: "Position", ph: "e.g. Cashier" },
      {
        n: "role",
        l: "Role",
        t: "select",
        ph: "Select a role",
        o: Object.entries(ROLE).filter((r) => r[0] != "admin"),
      },
      {
        n: "pw",
        l: "Password",
        t: "password",
        ph: "At least 6 characters",
        v: (x) => (x.length < 6 ? "Use at least 6 characters" : ""),
      },
      {
        n: "pw2",
        l: "Confirm password",
        t: "password",
        ph: "Re-enter your password",
        v: (x, d) => (x !== d.pw ? "Passwords do not match" : ""),
      },
    ],
    {},
    async (d) => {
      const j = await api("register", {
        name: d.name,
        title: d.title,
        role: d.role,
        password: d.pw,
      });
      if (!j) return;
      await initLogin();
      $("#lu").value = j.username || "";
      $("#lp").focus();
      toast(
        "Account created. Your username is " +
          j.username +
          ". Sign in to continue.",
      );
    },
  );
}
const prodActs = (id) =>
  acts("prod", id) +
  " " +
  `<button class="b s stk" data-a="adj" data-id="${id}">Adjust stock</button>`;
function rEmp() {
  const q = $("#eq").value.toLowerCase();
  tbl(
    "#etbl",
    [
      ["Name", (u) => `<div class="pn">${av(u.name)}<b>${e(u.name)}</b></div>`],
      ["Position", (u) => e(u.title)],
      [
        "Role",
        (u) =>
          `<span class="tg ${u.role == "admin" ? "ok" : ""}">${ROLE[u.role]}</span>`,
      ],
      ["Phone", (u) => e(u.phone), "m"],
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
        (u.name + u.title).toLowerCase().includes(q),
    ),
    "No employees match your filter.",
    (u) => (u.status == "Inactive" ? "arch" : ""),
  );
}
function rLogs() {
  const q = $("#lq").value.toLowerCase();
  $("#ltbl").innerHTML = tlHtml(
    db.logs.filter((l) => (l.u + l.a).toLowerCase().includes(q)).reverse(),
  );
  rHist(q);
}
/* Record change history: previous values of edited, archived and restored records */
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
  v === null || v === "" || v === undefined
    ? "—"
    : k == "category_id"
      ? nm("cats", +v)
      : k == "supplier_id"
        ? nm("sup", +v)
        : k == "role_id"
          ? ROLE[["", "admin", "manager", "inventory", "cashier"][+v]] || v
          : String(v);
const hdiff = (h) =>
  Object.keys(h.new)
    .filter(
      (k) =>
        h.old[k] !== h.new[k] && !(k == "archived_at" && h.type != "UPDATE"),
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
      ["Record", (r) => `<b>${e(r.name)}</b><div class="mu2">${e(r.t)}</div>`],
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
                    `<div class="mu2"><b>${e(x[0])}:</b> ${e(x[1])} → ${e(x[2])}</div>`,
                )
                .join("")
            : "—",
      ],
      ["By", (r) => e(r.h.u)],
    ],
    rows,
    "No changes recorded yet.",
  );
}
/* SETTINGS = the signed-in employee's own details (name, position, email, phone, password) */
function rSet() {
  $("#setv").innerHTML = `<table><tbody>${[
    ["Full name", me.name],
    ["Position", me.title || "—"],
    ["Email", me.email || "—"],
    ["Mobile number", me.phone || "—"],
    ["Password", "••••••••"],
  ]
    .map((r) => `<tr><td><b>${r[0]}</b></td><td>${e(r[1])}</td></tr>`)
    .join("")}</tbody></table>`;
}
function rProfile() {
  $("#profv").innerHTML =
    `<div class="pn" data-st="margin-bottom:14px">${av(me.name)}<div><b>${e(me.name)}</b><div class="mu2">${e(me.title || "—")} · ${ROLE[me.role]}</div></div></div><table><tbody>${[
      ["Username", me.username],
      ["Email", me.email || "—"],
      ["Mobile number", me.phone || "—"],
      ["Role", ROLE[me.role]],
      ["Account created", me.cr || "—"],
      ["Last updated", me.up || "—"],
    ]
      .map((r) => `<tr><td><b>${r[0]}</b></td><td>${e(r[1])}</td></tr>`)
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
      if (!(await api("update_profile", d))) return;
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
        return;
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
      if (!(await api("save_settings", d))) return;
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
      `<p class="mu">Created ${e(db.set.cr || "—")} · Last updated ${e(db.set.up || "—")}</p>`,
    );
}
// STOCK COUNT CORRECTION
function adjust(id) {
  const p = P(id);
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
      if (!(await api("adjust_stock", { pid: id, stock: d.stock }))) return;
      await load();
      show(cur);
      toast(`Quantity updated: ${p.name} now ${d.stock} ${p.unit}`);
    },
  );
}
/* MOCK NOTIFICATIONS */
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
  ...(ADM()
    ? [
        {
          id: "inv1",
          v: "suppliers",
          t: "Supplier invoice due",
          s: "Batangas Steel Trading Corp., due in 3 days",
        },
        {
          id: "po1",
          v: "movements",
          t: "Delivery expected",
          s: "Calamba Cement & Masonry Depot, PO-2226",
        },
      ]
    : []),
]; // TODO: GET /api/notifications
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
/* LOGIN PASSWORD CHECKED AGAINST THE HASH*/
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
    lb.classList.add("e"); /* stays red until the user edits the password */
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

  await api("log", { text: "Signed out" }, true);
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
    signup: signUp,
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
["#pq", "#sq"].forEach((s) => ($(s).oninput = () => show(cur)));
["#pc", "#mf", "#pa", "#ca", "#sa", "#ea"].forEach(
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
  if (me) show(cur); /* redraw so charts pick up the new colours */
}
try {
  const t = localStorage.getItem("th");
  if (t == "dark" || t == "light") root.dataset.theme = t;
} catch (_) {}
syncThemeUI();
["#th", "#lth"].forEach(
  (s) => ($(s).onclick = () => applyTheme(isDark() ? "light" : "dark", true)),
);
/* follow the operating system while the user has not picked a theme */
osDark.addEventListener("change", () => {
  if (!root.dataset.theme) {
    syncThemeUI();
    if (me) show(cur);
  }
});
/* ============ COMMAND CENTER, STATUS, TIMELINE, NOTIFICATIONS ============ */
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
  `<div class="pb"><i class="${stc(p)[1]}" data-st="width:${Math.min(100, Math.round((p.stock / (p.min * 3)) * 100))}%"></i></div>`;
const stk = (p) =>
  `<div data-st="min-width:110px"><b>${p.stock}</b> <span class="mu2">${e(p.unit)}</span>${pb(p)}</div>`;
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
  // NUMBER ANIMATIONN CHUCHU
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
// DASHBOARD COMMAND CENTER
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
    hs = Math.round((ok / PR.length) * 100);
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
  $("#dash").innerHTML = `<div class="dg">
<div class="hr"><div><div class="eb">${new Date().toLocaleDateString("en-PH", { weekday: "long", month: "long", day: "numeric" })}</div><h2>${gr}, ${e(fn)}!</h2><div class="rl">${ROLE[me.role]} · Stock Keeper</div><p data-st="margin-top:12px">${low.length ? `<b>${low.length} item${low.length > 1 ? "s" : ""}</b> need restocking${out ? `, ${out} already out of stock` : ""}. ` : "All stock levels are healthy. "}${tx} sales logged so far, worth ${money(rev)}.</p><div class="hq">${qa.map((a, i) => `<button class="hb${i ? "" : " o"}" ${a[1]}><span class="ms">${a[2]}</span>${a[3]}</button>`).join("")}</div></div>
<div class="rv"><div class="eb">Revenue · last 7 days</div><b data-n="${wk}" data-f="m">0</b><div class="rvs"><span class="dl ${dl < 0 ? "dn" : ""}"><span class="ms">${dl < 0 ? "trending_down" : "trending_up"}</span>${Math.abs(dl)}%</span><span>Latest day ${money(ld)} vs daily avg</span></div>${dv.length > 1 ? `<svg viewBox="0 0 260 72" preserveAspectRatio="none" width="100%" height="72"><defs><linearGradient id="sg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#FBBF24" stop-opacity=".45"/><stop offset="1" stop-color="#FBBF24" stop-opacity="0"/></linearGradient></defs><path d="${pth} L260 72 L0 72Z" fill="url(#sg)"/><path d="${pth}" fill="none" stroke="#FBBF24" stroke-width="2.5" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>` : ""}</div></div>
<div class="s4 tile" data-st="background:linear-gradient(135deg,#1E4FBF,#3B82F6)"><div class="t1"><span class="ms">warehouse</span>Inventory value</div><b data-n="${val}" data-f="m">0</b><div class="t2">${PR.length} products across ${actv("cats").length} categories</div><div class="sb">${cv.map((c) => `<i title="${e(c[0].name)}" data-st="flex:${c[1] || 1};background:${cc(c[0].id)}"></i>`).join("")}</div></div>
<div class="s4 tile" data-st="background:linear-gradient(135deg,#C2410C,#F59E0B)"><div class="t1"><span class="ms">warning</span>Needs restocking</div><b data-n="${low.length}">0</b><div class="t2">Est. restock cost ${money(rs)}</div><button class="hb" data-v="products" data-st="margin-top:14px">Review items</button></div>
<div class="s4 tile" data-st="background:linear-gradient(135deg,#0F766E,#14B8A6)"><div class="t1"><span class="ms">receipt_long</span>Sales performance</div><b data-n="${tx}">0</b><div class="t2">Avg. ticket ${money(tk)}${top[0] ? ` · Top: ${e(P(+top[0][0]).name)}` : ""}</div></div>
<div class="s8 w">${wh("Sales trend", "Daily revenue, last 7 days of activity", "reports")}<div class="cv"><canvas id="h1"></canvas></div></div>
<div class="s4 w">${wh("Inventory health", ok + " of " + PR.length + " products above reorder level")}<div class="hl"><canvas id="h2"></canvas><div class="ct"><div><b>${hs}%</b><span class="mu2">healthy</span></div></div></div><div class="lgd"><span><span class="cd" data-st="--c:#10B981"></span>${ok} healthy</span><span><span class="cd" data-st="--c:#F59E0B"></span>${low.length - out} low</span><span><span class="cd" data-st="--c:#EF4444"></span>${out} out</span></div></div>
<div class="s5 w">${wh("Needs restocking", "Lowest stock first", "products")}${
    low.length
      ? low
          .sort((a, b) => a.stock / a.min - b.stock / b.min)
          .slice(0, 5)
          .map(
            (p) =>
              `<div class="li"><span class="ch" data-st="--c:${cc(p.cat)}"><span class="ms">${ci(p.cat)}</span></span><div><b>${e(p.name)}</b><div class="mu2">${p.stock} ${e(p.unit)} left · reorder at ${p.min} · ${e(nm("sup", p.sup))}</div>${pb(p)}</div>${can("manage") || can("stock") ? '<button class="b s" data-a="po">Create PO</button>' : ""}</div>`,
          )
          .join("")
      : empty(
          "verified",
          "Stock is healthy",
          "Nothing is below its reorder level.",
        )
  }</div>
<div class="s7 w">${wh("Recent sales", "Click a sale to open its receipt", "sales")}${
    db.sales
      .slice(-5)
      .reverse()
      .map(
        (s) =>
          `<div class="li" data-a="sale" data-id="${s.id}"><span class="ch" data-st="--c:${PAY[s.pay] || "#2563EB"}">${ini(s.cust.replace(/^(Engr\.|Dra\.|Aling|Mang|Kuya|Ate)\s/, ""))}</span><div><b>${e(s.cust)}</b><div class="mu2">${s.id} · ${s.items.length} item${s.items.length > 1 ? "s" : ""} · ${e(s.by || "—")}</div></div><div data-st="text-align:right"><b class="m">${money(total(s))}</b><div><span class="st" data-st="--c:${PAY[s.pay] || "#2563EB"}">${e(s.pay)}</span></div></div></div>`,
      )
      .join("") ||
    empty("receipt_long", "No sales yet", "Completed sales will appear here.")
  }</div>
<div class="s6 w">${wh("Inventory movements", "Latest stock in and out", "movements")}${mv.map((m) => `<div class="li"><span class="ch" data-st="--c:${m.type == "IN" ? "#10B981" : "#EF4444"}"><span class="ms">${m.type == "IN" ? "south_west" : "north_east"}</span></span><div><b>${e(P(m.pid).name || "—")}</b><div class="mu2">${e(m.note)} · ${e(m.by || "—")}</div></div><div data-st="text-align:right"><b class="m" data-st="color:${m.type == "IN" ? "#10B981" : "#EF4444"}">${m.type == "IN" ? "+" : "−"}${m.qty}</b><div class="mu2">${fd(m.date)}</div></div></div>`).join("") || empty("swap_vert", "No movements yet", "Stock in and out will appear here.")}</div>
<div class="s6 w">${wh("Team activity", "What your staff has been doing", "logs")}<div class="feed">${lg.map((l) => `<div class="fi">${av(l.u)}<div><b>${e(l.u)}</b> <span class="mu2">· ${ROLE[l.r]}</span><div>${e(l.a)}</div></div><span class="mu2">${fd(l.t)}, ${l.t.slice(11)}</span></div>`).join("")}</div></div>
<div class="s6 w">${wh("Top-selling products", "By revenue")}${top.map((t) => `<div class="li"><div data-st="flex:1"><div data-st="display:flex;justify-content:space-between"><b>${e(P(+t[0]).name)}</b><span class="m">${money(t[1])}</span></div><div class="tb"><i data-st="--c:${cc(P(+t[0]).cat)};width:${Math.round((t[1] / tm) * 100)}%"></i></div></div></div>`).join("") || empty("trending_up", "No sales data yet", "Top sellers appear after the first sale.")}</div>
<div class="s6 w">${wh("Stock by category", "Units on hand")}<div class="cv"><canvas id="h3"></canvas></div></div></div>`;
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
        `<div class="tli"><span class="ti" data-st="--c:${k[1]}"><span class="ms">${k[0]}</span></span><div><b>${e(l.a)}</b><div class="mu2">${e(l.u)} · ${ROLE[l.r]} · ${l.t.slice(11)}</div></div></div>`
      );
    }).join("") +
    "</div>"
  );
}
/* NOTIF CENTER */
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
                `<div class="nt" data-v="${n.v}" data-st="--c:${n.m[1]}"><span class="ti"><span class="ms">${n.m[0]}</span></span><div data-st="flex:1"><div data-st="font-weight:${seen.has(n.id) ? 400 : 700}">${e(n.t)}</div><div class="mu2">${e(n.s)}</div></div><span class="mu2">${n.ago}</span></div>`,
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
/* Start: restore an existing session, otherwise show the login screen */
(async () => {
  if (await load(true)) startUI(false);
  else initLogin();
})();
