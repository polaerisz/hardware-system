CREATE DATABASE IF NOT EXISTS stockkeeper_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE stockkeeper_db;

SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS record_history, settings, activity_logs, sale_items, sales, inventory_movements,
                     product_suppliers, product_categories, products, customers, suppliers, categories, user_roles, users, roles;
SET FOREIGN_KEY_CHECKS = 1;

-- ROLES
CREATE TABLE roles (
  role_id    TINYINT UNSIGNED NOT NULL AUTO_INCREMENT,
  role_name  VARCHAR(30)      NOT NULL,
  CONSTRAINT pk_roles PRIMARY KEY (role_id),
  CONSTRAINT uq_roles_name UNIQUE (role_name)
) ENGINE=InnoDB;

-- TABLE FOR USERS
CREATE TABLE users (
  user_id        INT UNSIGNED     NOT NULL AUTO_INCREMENT,
  full_name      VARCHAR(100)     NOT NULL,
  username       VARCHAR(40)      NOT NULL,
  email          VARCHAR(120)     NOT NULL,
  password_hash  VARCHAR(255)     NOT NULL,           -- the scrambled (hashed) password from PHP, never the real password
  job_title      VARCHAR(80)      NULL,
  phone          VARCHAR(30)      NULL,
  status         ENUM('Active','Inactive') NOT NULL DEFAULT 'Active',
  created_at     TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- filled in when the account is made
  updated_at     TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,  -- updates by itself every time the row changes
  -- Employees are never deleted or archived. The `status` (Active/Inactive) decides if they can log in.
  CONSTRAINT pk_users PRIMARY KEY (user_id),
  CONSTRAINT uq_users_username UNIQUE (username),
  CONSTRAINT uq_users_email    UNIQUE (email),
  -- Extra safety: the database also rejects short or readable values like 'Password123' (it must be a real hash).
  CONSTRAINT chk_users_hash CHECK (CHAR_LENGTH(password_hash) >= 60 AND password_hash LIKE '$%')
) ENGINE=InnoDB;

-- USER ROLES (an employee can have many roles, and a role can belong to many employees)
-- An employee can do everything that any of their roles can do. Every employee must have at least one role (api.php makes sure of this).
CREATE TABLE user_roles (
  user_id      INT UNSIGNED     NOT NULL,
  role_id      TINYINT UNSIGNED NOT NULL,
  assigned_at  DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_user_roles PRIMARY KEY (user_id, role_id),
  CONSTRAINT fk_ur_user FOREIGN KEY (user_id) REFERENCES users (user_id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_ur_role FOREIGN KEY (role_id) REFERENCES roles (role_id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  KEY idx_ur_role (role_id)
) ENGINE=InnoDB;

-- CATEGORIES
CREATE TABLE categories (
  category_id    SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
  category_name  VARCHAR(60)       NOT NULL,
  description    VARCHAR(255)      NULL,
  archived_at    DATETIME         NULL DEFAULT NULL,  -- empty (NULL) = active, has a date = archived (can be restored)
  created_at     DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- filled in when the record is made
  updated_at     DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,  -- updates by itself every time the row changes
  CONSTRAINT pk_categories PRIMARY KEY (category_id),
  CONSTRAINT uq_categories_name UNIQUE (category_name)
) ENGINE=InnoDB;

-- SUPPLIERS
CREATE TABLE suppliers (
  supplier_id     SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_name    VARCHAR(120)      NOT NULL,
  contact_person  VARCHAR(100)      NOT NULL,
  phone           VARCHAR(30)       NOT NULL,
  email           VARCHAR(120)      NULL,
  address         VARCHAR(255)      NOT NULL,                 -- whole address in one line, api.php builds it from the four parts below
  street          VARCHAR(120)      NULL,                     -- street / building (optional)
  barangay        VARCHAR(80)       NULL,
  city            VARCHAR(80)       NULL,
  province        VARCHAR(80)       NULL,
  archived_at    DATETIME         NULL DEFAULT NULL,  -- empty (NULL) = active, has a date = archived (can be restored)
  created_at     DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- filled in when the record is made
  updated_at     DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,  -- updates by itself every time the row changes
  CONSTRAINT pk_suppliers PRIMARY KEY (supplier_id),
  CONSTRAINT uq_suppliers_company UNIQUE (company_name)
) ENGINE=InnoDB;

-- PRODUCTS
CREATE TABLE products (
  product_id      INT UNSIGNED      NOT NULL AUTO_INCREMENT,
  sku             VARCHAR(30)       NOT NULL,
  product_name    VARCHAR(150)      NOT NULL,
  unit_price      DECIMAL(10,2)     NOT NULL,
  stock_quantity  INT               NOT NULL DEFAULT 0,
  reorder_level   INT               NOT NULL DEFAULT 10,
  unit            VARCHAR(20)       NOT NULL DEFAULT 'pcs',
  archived_at    DATETIME         NULL DEFAULT NULL,  -- empty (NULL) = active, has a date = archived (can be restored)
  created_at     DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- filled in when the record is made
  updated_at     DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,  -- updates by itself every time the row changes
  CONSTRAINT pk_products PRIMARY KEY (product_id),
  CONSTRAINT uq_products_sku UNIQUE (sku),
  CONSTRAINT chk_products_price CHECK (unit_price > 0),
  CONSTRAINT chk_products_stock CHECK (stock_quantity >= 0),
  CONSTRAINT chk_products_reorder CHECK (reorder_level >= 0),
  KEY idx_products_name (product_name)
) ENGINE=InnoDB;

-- PRODUCT CATEGORIES (a product can be in many categories, and a category can have many products)
-- is_primary marks the MAIN category of a product. We use it for the SKU start, the color/icon and the totals per category,
-- so nothing gets counted twice. Same idea as product_suppliers: the generated column + UNIQUE key makes sure
-- a product has only ONE main category. If the main category is archived, the backend picks another active one.
CREATE TABLE product_categories (
  product_id   INT UNSIGNED      NOT NULL,
  category_id  SMALLINT UNSIGNED NOT NULL,
  is_primary   TINYINT(1)        NOT NULL DEFAULT 0,
  primary_for  INT UNSIGNED GENERATED ALWAYS AS (IF(is_primary = 1, product_id, NULL)) STORED,
  created_at   DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_product_categories PRIMARY KEY (product_id, category_id),
  CONSTRAINT uq_product_main_category UNIQUE (primary_for),
  -- RESTRICT on the product side because MySQL/MariaDB don't allow cascading actions on the column that a stored generated column is based on.
  CONSTRAINT fk_pc_product FOREIGN KEY (product_id) REFERENCES products (product_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pc_category FOREIGN KEY (category_id) REFERENCES categories (category_id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT chk_pc_primary CHECK (is_primary IN (0, 1)),
  KEY idx_pc_category (category_id)
) ENGINE=InnoDB;

-- PRODUCT SUPPLIERS (a product can have many suppliers, and a supplier can supply many products)
-- is_primary marks the main supplier of a product. The generated column + UNIQUE key makes the database itself
-- allow only ONE main supplier per product. If the main supplier is archived, the backend
-- makes another active supplier of that product the main one.
CREATE TABLE product_suppliers (
  product_id   INT UNSIGNED      NOT NULL,
  supplier_id  SMALLINT UNSIGNED NOT NULL,
  is_primary   TINYINT(1)        NOT NULL DEFAULT 0,
  primary_for  INT UNSIGNED GENERATED ALWAYS AS (IF(is_primary = 1, product_id, NULL)) STORED,
  created_at   DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_product_suppliers PRIMARY KEY (product_id, supplier_id),
  CONSTRAINT uq_product_primary UNIQUE (primary_for),
  -- RESTRICT (not CASCADE) because MySQL/MariaDB don't allow cascading actions on the column that a stored generated column is based on.
  -- Products are never deleted anyway (we archive them), so nothing is lost.
  CONSTRAINT fk_ps_product FOREIGN KEY (product_id) REFERENCES products (product_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ps_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers (supplier_id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT chk_ps_primary CHECK (is_primary IN (0, 1)),
  KEY idx_ps_supplier (supplier_id)
) ENGINE=InnoDB;

-- INVENTORY MOVEMENTS
CREATE TABLE inventory_movements (
  movement_id    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id     INT UNSIGNED    NOT NULL,
  user_id        INT UNSIGNED    NOT NULL,
  movement_type  ENUM('IN','OUT','ADJ_IN','ADJ_OUT') NOT NULL,
  quantity       INT             NOT NULL,            -- always a positive number, movement_type tells if it is in or out
  remarks        VARCHAR(255)    NULL,
  movement_date  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_movements PRIMARY KEY (movement_id),
  -- A product's stock history is only removed together with the product (only possible if it was never sold).
  CONSTRAINT fk_movements_product FOREIGN KEY (product_id) REFERENCES products (product_id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_movements_user FOREIGN KEY (user_id) REFERENCES users (user_id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT chk_movements_qty CHECK (quantity > 0),
  KEY idx_movements_product_date (product_id, movement_date),
  KEY idx_movements_user (user_id),
  KEY idx_movements_date (movement_date)
) ENGINE=InnoDB;

-- CUSTOMERS
CREATE TABLE customers (
  customer_id    INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  customer_code  VARCHAR(16)   NULL,                  -- customer ID made by the system (CUST-0001), set right after the insert. Two customers can have the same name but never the same ID
  customer_name  VARCHAR(120)  NOT NULL,
  phone          VARCHAR(30)   NOT NULL,              -- mobile number
  street         VARCHAR(150)  NULL,                  -- street / building (optional)
  barangay       VARCHAR(80)   NOT NULL,
  city           VARCHAR(80)   NOT NULL,
  province       VARCHAR(80)   NOT NULL,
  archived_at    DATETIME      NULL DEFAULT NULL,     -- empty (NULL) = active, has a date = archived (can be restored)
  created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- filled in when the record is made
  updated_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,  -- updates by itself every time the row changes
  CONSTRAINT pk_customers PRIMARY KEY (customer_id),
  CONSTRAINT uq_customers_code UNIQUE (customer_code),
  KEY idx_customers_name (customer_name),
  KEY idx_customers_area (province, city, barangay)
) ENGINE=InnoDB;

-- SALES
CREATE TABLE sales (
  sale_id         INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  receipt_number  VARCHAR(20)   NOT NULL,
  user_id         INT UNSIGNED  NOT NULL,              -- the cashier who made the sale
  customer_id     INT UNSIGNED  NULL,                  -- saved customer. NULL = walk-in customer or an older record
  customer_name   VARCHAR(120)  NOT NULL DEFAULT 'Walk-in',  -- name as shown on the receipt (saved as it was, so it stays the same even if the customer is edited later)
  payment_method  ENUM('Cash','GCash','Maya','Bank transfer','Charge account') NOT NULL,
  total_amount    DECIMAL(12,2) NOT NULL DEFAULT 0.00, -- the backend computes this by adding up all the sale_items subtotals when it saves the sale
  sale_date       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_sales PRIMARY KEY (sale_id),
  CONSTRAINT uq_sales_receipt UNIQUE (receipt_number),
  CONSTRAINT fk_sales_user FOREIGN KEY (user_id) REFERENCES users (user_id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_sales_customer FOREIGN KEY (customer_id) REFERENCES customers (customer_id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT chk_sales_total CHECK (total_amount >= 0),
  KEY idx_sales_date (sale_date),
  KEY idx_sales_user (user_id),
  KEY idx_sales_customer (customer_id),
  KEY idx_sales_payment (payment_method)
) ENGINE=InnoDB;

-- SALE ITEMS
CREATE TABLE sale_items (
  sale_item_id  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sale_id       INT UNSIGNED    NOT NULL,
  product_id    INT UNSIGNED    NOT NULL,
  product_name  VARCHAR(150)    NOT NULL DEFAULT '',      -- product name at the time of the sale (filled in by a trigger), so renaming a product doesn't change old receipts
  quantity      INT             NOT NULL,
  unit_price    DECIMAL(10,2)   NOT NULL,              -- price at the time of the sale (stays the same even if the price changes later)
  subtotal      DECIMAL(12,2)   GENERATED ALWAYS AS (quantity * unit_price) STORED,
  CONSTRAINT pk_sale_items PRIMARY KEY (sale_item_id),
  CONSTRAINT uq_sale_items_line UNIQUE (sale_id, product_id),
  CONSTRAINT fk_sale_items_sale FOREIGN KEY (sale_id) REFERENCES sales (sale_id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_sale_items_product FOREIGN KEY (product_id) REFERENCES products (product_id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT chk_sale_items_qty CHECK (quantity > 0),
  CONSTRAINT chk_sale_items_price CHECK (unit_price >= 0),
  KEY idx_sale_items_product (product_id)
) ENGINE=InnoDB;

-- ACTIVITY LOGS
CREATE TABLE activity_logs (
  log_id        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id       INT UNSIGNED    NULL,
  action        VARCHAR(40)     NOT NULL,
  description   VARCHAR(500)    NOT NULL,
  date_created  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_activity_logs PRIMARY KEY (log_id),
  CONSTRAINT fk_logs_user FOREIGN KEY (user_id) REFERENCES users (user_id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  KEY idx_logs_user (user_id),
  KEY idx_logs_date (date_created),
  KEY idx_logs_action (action)
) ENGINE=InnoDB;

-- SETTINGS
CREATE TABLE settings (
  setting_id      TINYINT UNSIGNED NOT NULL DEFAULT 1,
  store_name      VARCHAR(100)     NOT NULL,
  tax_rate        DECIMAL(5,2)     NOT NULL DEFAULT 12.00,
  reorder_level   INT              NOT NULL DEFAULT 20,
  receipt_footer  VARCHAR(255)     NULL,
  created_at      DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- filled in when the settings row is made
  updated_at      DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,  -- updates by itself every time the row changes
  CONSTRAINT pk_settings PRIMARY KEY (setting_id),
  CONSTRAINT chk_settings_single CHECK (setting_id = 1),
  CONSTRAINT chk_settings_tax CHECK (tax_rate >= 0 AND tax_rate <= 100)
) ENGINE=InnoDB;

-- RECORD HISTORY: a list of every edit, archive and restore (with the old and new values). We only add rows, never change or remove them, so we can look back later.
CREATE TABLE record_history (
  history_id   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  table_name   VARCHAR(30)     NOT NULL,                 -- which table: products, categories, suppliers, customers, users, settings
  record_id    INT UNSIGNED    NOT NULL,                 -- id of the record that was changed
  change_type  ENUM('UPDATE','ARCHIVE','RESTORE') NOT NULL,
  old_values   JSON            NOT NULL,                 -- how the record looked before the change (passwords are never copied)
  new_values   JSON            NOT NULL,                 -- how the record looks after the change
  changed_by   INT UNSIGNED    NULL,                     -- the employee who made the change (api.php sets this)
  changed_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_record_history PRIMARY KEY (history_id),
  CONSTRAINT fk_history_user FOREIGN KEY (changed_by) REFERENCES users (user_id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  KEY idx_history_record (table_name, record_id),
  KEY idx_history_date (changed_at)
) ENGINE=InnoDB;

-- =============================================================================
-- NO PERMANENT DELETE: the database won't allow DELETE on our business records (archive them instead).
-- These triggers are only one statement each, so we don't need to change the DELIMITER when importing.
-- =============================================================================
CREATE TRIGGER trg_no_delete_categories BEFORE DELETE ON categories FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Records are never permanently deleted. Archive the record instead.';
CREATE TRIGGER trg_no_delete_suppliers BEFORE DELETE ON suppliers FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Records are never permanently deleted. Archive the record instead.';
CREATE TRIGGER trg_no_delete_customers BEFORE DELETE ON customers FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Records are never permanently deleted. Archive the record instead.';
CREATE TRIGGER trg_no_delete_products BEFORE DELETE ON products FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Records are never permanently deleted. Archive the record instead.';
CREATE TRIGGER trg_no_delete_users BEFORE DELETE ON users FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Records are never permanently deleted. Archive the record instead.';
CREATE TRIGGER trg_no_delete_sales BEFORE DELETE ON sales FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Records are never permanently deleted. Archive the record instead.';
CREATE TRIGGER trg_no_delete_sale_items BEFORE DELETE ON sale_items FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Records are never permanently deleted. Archive the record instead.';
CREATE TRIGGER trg_no_delete_inventory_movements BEFORE DELETE ON inventory_movements FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Records are never permanently deleted. Archive the record instead.';
CREATE TRIGGER trg_no_delete_activity_logs BEFORE DELETE ON activity_logs FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Records are never permanently deleted. Archive the record instead.';
CREATE TRIGGER trg_no_delete_settings BEFORE DELETE ON settings FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Records are never permanently deleted. Archive the record instead.';
CREATE TRIGGER trg_no_delete_record_history BEFORE DELETE ON record_history FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Records are never permanently deleted. Archive the record instead.';
CREATE TRIGGER trg_no_update_inventory_movements BEFORE UPDATE ON inventory_movements FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Historical records cannot be edited.';
CREATE TRIGGER trg_no_update_sale_items BEFORE UPDATE ON sale_items FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Historical records cannot be edited.';
CREATE TRIGGER trg_no_update_activity_logs BEFORE UPDATE ON activity_logs FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Historical records cannot be edited.';
CREATE TRIGGER trg_no_update_record_history BEFORE UPDATE ON record_history FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Historical records cannot be edited.';

-- SALE ITEM NAME COPY (every new sale line saves the product name as it was when sold)
CREATE TRIGGER trg_sale_items_name BEFORE INSERT ON sale_items FOR EACH ROW
  SET NEW.product_name = COALESCE(NULLIF(NEW.product_name, ''), (SELECT p.product_name FROM products p WHERE p.product_id = NEW.product_id), '');

-- HISTORY TRIGGERS (copy the old and new values into record_history whenever something really changes)
CREATE TRIGGER trg_hist_products AFTER UPDATE ON products FOR EACH ROW
  INSERT INTO record_history (table_name, record_id, change_type, old_values, new_values, changed_by)
  SELECT 'products', OLD.product_id,
    CASE WHEN OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN 'ARCHIVE'
         WHEN OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL THEN 'RESTORE' ELSE 'UPDATE' END,
    JSON_OBJECT('sku', OLD.sku, 'product_name', OLD.product_name, 'unit_price', OLD.unit_price, 'reorder_level', OLD.reorder_level, 'unit', OLD.unit, 'archived_at', OLD.archived_at),
    JSON_OBJECT('sku', NEW.sku, 'product_name', NEW.product_name, 'unit_price', NEW.unit_price, 'reorder_level', NEW.reorder_level, 'unit', NEW.unit, 'archived_at', NEW.archived_at),
    @app_user_id
  FROM DUAL
  WHERE NOT (OLD.sku <=> NEW.sku AND OLD.product_name <=> NEW.product_name AND OLD.unit_price <=> NEW.unit_price AND OLD.reorder_level <=> NEW.reorder_level AND OLD.unit <=> NEW.unit AND OLD.archived_at <=> NEW.archived_at);
CREATE TRIGGER trg_hist_categories AFTER UPDATE ON categories FOR EACH ROW
  INSERT INTO record_history (table_name, record_id, change_type, old_values, new_values, changed_by)
  SELECT 'categories', OLD.category_id,
    CASE WHEN OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN 'ARCHIVE'
         WHEN OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL THEN 'RESTORE' ELSE 'UPDATE' END,
    JSON_OBJECT('category_name', OLD.category_name, 'description', OLD.description, 'archived_at', OLD.archived_at),
    JSON_OBJECT('category_name', NEW.category_name, 'description', NEW.description, 'archived_at', NEW.archived_at),
    @app_user_id
  FROM DUAL
  WHERE NOT (OLD.category_name <=> NEW.category_name AND OLD.description <=> NEW.description AND OLD.archived_at <=> NEW.archived_at);
CREATE TRIGGER trg_hist_suppliers AFTER UPDATE ON suppliers FOR EACH ROW
  INSERT INTO record_history (table_name, record_id, change_type, old_values, new_values, changed_by)
  SELECT 'suppliers', OLD.supplier_id,
    CASE WHEN OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN 'ARCHIVE'
         WHEN OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL THEN 'RESTORE' ELSE 'UPDATE' END,
    JSON_OBJECT('company_name', OLD.company_name, 'contact_person', OLD.contact_person, 'phone', OLD.phone, 'email', OLD.email, 'address', OLD.address, 'archived_at', OLD.archived_at),
    JSON_OBJECT('company_name', NEW.company_name, 'contact_person', NEW.contact_person, 'phone', NEW.phone, 'email', NEW.email, 'address', NEW.address, 'archived_at', NEW.archived_at),
    @app_user_id
  FROM DUAL
  WHERE NOT (OLD.company_name <=> NEW.company_name AND OLD.contact_person <=> NEW.contact_person AND OLD.phone <=> NEW.phone AND OLD.email <=> NEW.email AND OLD.address <=> NEW.address AND OLD.archived_at <=> NEW.archived_at);
CREATE TRIGGER trg_hist_customers AFTER UPDATE ON customers FOR EACH ROW
  INSERT INTO record_history (table_name, record_id, change_type, old_values, new_values, changed_by)
  SELECT 'customers', OLD.customer_id,
    CASE WHEN OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN 'ARCHIVE'
         WHEN OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL THEN 'RESTORE' ELSE 'UPDATE' END,
    JSON_OBJECT('customer_name', OLD.customer_name, 'phone', OLD.phone, 'street', OLD.street, 'barangay', OLD.barangay, 'city', OLD.city, 'province', OLD.province, 'archived_at', OLD.archived_at),
    JSON_OBJECT('customer_name', NEW.customer_name, 'phone', NEW.phone, 'street', NEW.street, 'barangay', NEW.barangay, 'city', NEW.city, 'province', NEW.province, 'archived_at', NEW.archived_at),
    @app_user_id
  FROM DUAL
  WHERE NOT (OLD.customer_name <=> NEW.customer_name AND OLD.phone <=> NEW.phone AND OLD.street <=> NEW.street AND OLD.barangay <=> NEW.barangay AND OLD.city <=> NEW.city AND OLD.province <=> NEW.province AND OLD.archived_at <=> NEW.archived_at);
CREATE TRIGGER trg_hist_users AFTER UPDATE ON users FOR EACH ROW
  INSERT INTO record_history (table_name, record_id, change_type, old_values, new_values, changed_by)
  SELECT 'users', OLD.user_id,
    'UPDATE',
    JSON_OBJECT('full_name', OLD.full_name, 'username', OLD.username, 'email', OLD.email, 'job_title', OLD.job_title, 'phone', OLD.phone, 'status', OLD.status),
    JSON_OBJECT('full_name', NEW.full_name, 'username', NEW.username, 'email', NEW.email, 'job_title', NEW.job_title, 'phone', NEW.phone, 'status', NEW.status),
    @app_user_id
  FROM DUAL
  WHERE NOT (OLD.full_name <=> NEW.full_name AND OLD.username <=> NEW.username AND OLD.email <=> NEW.email AND OLD.job_title <=> NEW.job_title AND OLD.phone <=> NEW.phone AND OLD.status <=> NEW.status);
CREATE TRIGGER trg_hist_settings AFTER UPDATE ON settings FOR EACH ROW
  INSERT INTO record_history (table_name, record_id, change_type, old_values, new_values, changed_by)
  SELECT 'settings', OLD.setting_id,
    'UPDATE',
    JSON_OBJECT('store_name', OLD.store_name, 'tax_rate', OLD.tax_rate, 'reorder_level', OLD.reorder_level, 'receipt_footer', OLD.receipt_footer),
    JSON_OBJECT('store_name', NEW.store_name, 'tax_rate', NEW.tax_rate, 'reorder_level', NEW.reorder_level, 'receipt_footer', NEW.receipt_footer),
    @app_user_id
  FROM DUAL
  WHERE NOT (OLD.store_name <=> NEW.store_name AND OLD.tax_rate <=> NEW.tax_rate AND OLD.reorder_level <=> NEW.reorder_level AND OLD.receipt_footer <=> NEW.receipt_footer);

-- =============================================================================
-- Stock Keeper · Sample data (Filipino business records)
-- Every user below starts with the password  StockKeeper@2026  but we only save it as a bcrypt hash (scrambled).
-- Please change these passwords after the first login.
-- Each hash looks different because password_hash() adds random extra characters (a salt) every time.
-- =============================================================================

INSERT INTO roles (role_id, role_name) VALUES
 (1,'Administrator'),(2,'Manager'),(3,'Inventory Staff'),(4,'Cashier');

INSERT INTO users (user_id, full_name, username, email, password_hash, job_title, phone, status) VALUES
 (1,'Criselle Enraca','criselle.enraca','criselle.enraca@stockkeeper.example','$2y$10$9kND5iDmUj2sQt4mpGbcp.3MVphroXbZjMWhncGPYudMs4u5g0m1m','Owner & General Manager','0917 301 5521','Active'),
 (2,'Zosaine Manaig','zosaine.manaig','zosaine.manaig@stockkeeper.example','$2y$10$Q.C0nRR1QseoyYOgwG7XBehtNqWgAXCV5Vyi4y/urzGwoee9CVLRG','Operations Manager','0928 440 7316','Active'),
 (3,'Rainzell Espaldon','rainzell.espaldon','rainzell.espaldon@stockkeeper.example','$2y$10$J5e1pFZ5ZgGjPqxgYRVPJe9YVSgkMioht5CK6nCGPFOMlIR.wJRuq','Warehouse Supervisor','0939 215 8840','Active'),
 (4,'Althea Aquino','althea.aquino','althea.aquino@stockkeeper.example','$2y$10$jRQJfPm/rtcdyTxNGjuDQuIR4h0oX5ojNRqbG.pfi3agDM6zGaA9K','Head Cashier','0966 702 1193','Active'),
 (5,'Andrei Reyes','andrei.reyes','andrei.reyes@stockkeeper.example','$2y$10$ca95.VNFSo1PDhokfVmIou7/GX.Rh8uxFUr.5MiNFClsNHzcbrAza','Stockroom Assistant','0905 118 6672','Active'),
 (6,'Jhan Vincent Miraples','jhanvincent.miraples','jhanvincent.miraples@stockkeeper.example','$2y$10$QFBvsiurazpkxdfYfNs0Luz87GDOHcsUNAErNPTMFS1XYoFJwfYAG','Sales Associate','0977 836 2204','Active');

-- Every employee has at least one role. In the sample data, Zosaine (Manager) is also Inventory Staff,
-- and Althea (Cashier) also helps with the stock.
INSERT INTO user_roles (user_id, role_id) VALUES
 (1,1),(2,2),(3,3),(4,4),(5,3),(6,4),(2,3),(4,3);

INSERT INTO categories (category_id, category_name, description) VALUES
 (1,'Cement & Masonry','Portland cement, CHB, hollow blocks'),
 (2,'Steel & Wire','Rebars, GI wire, tie wire'),
 (3,'Lumber & Boards','Marine plywood, coco lumber'),
 (4,'Plumbing','PVC pipes, valves, fittings'),
 (5,'Electrical','Wires, breakers, conduit'),
 (6,'Paint & Sealants','Latex paint, roof sealant'),
 (7,'Fasteners','Nails, screws, bolts');

INSERT INTO suppliers (supplier_id, company_name, contact_person, phone, email, address, street, barangay, city, province) VALUES
 (1,'Calamba Cement & Masonry Depot','Ernesto Dimaculangan','0917 812 4405','orders@calambacement.example','Brgy. Real, Calamba City, Laguna',NULL,'Real','Calamba City','Laguna'),
 (2,'Batangas Steel Trading Corp.','Lorna Macalintal','0928 553 1076','sales@batangassteel.example','Brgy. Pallocan West, Batangas City, Batangas',NULL,'Pallocan West','Batangas City','Batangas'),
 (3,'Imus Lumber & Plywood Center','Rodel Bautista','0998 217 6630','imuslumber@trade.example','Brgy. Anabu II-A, Imus City, Cavite',NULL,'Anabu II-A','Imus City','Cavite'),
 (4,'Valenzuela Pipe & Fittings Supply','Cherry Anne Santos','(02) 8365 1420','benta@valpipe.example','MacArthur Highway, Brgy. Karuhatan, Valenzuela City, Metro Manila','MacArthur Highway','Karuhatan','Valenzuela City','Metro Manila'),
 (5,'San Pedro Electrical Supply','Noel Cabrera','0919 674 2285','noel@sanpedroelec.example','Brgy. Landayan, San Pedro City, Laguna',NULL,'Landayan','San Pedro City','Laguna'),
 (6,'Lipa Paints & Coatings Co.','Marites Landicho','0945 330 7918','accounts@lipapaints.example','Brgy. Sabang, Lipa City, Batangas',NULL,'Sabang','Lipa City','Batangas');

INSERT INTO customers (customer_id, customer_name, phone, street, barangay, city, province) VALUES
 (1,'JM Dela Cruz Construction','0917 622 3041','National Highway','Halang','Calamba City','Laguna'),
 (2,'Engr. Ramon Villanueva','0928 714 5530',NULL,'Real','Calamba City','Laguna'),
 (3,'Aling Lourdes Magsaysay','0939 408 1127','Rizal Street','Landayan','San Pedro City','Laguna'),
 (4,'Brgy. San Antonio Captain''s Office','0945 276 9083','Barangay Hall','San Antonio','Biñan City','Laguna'),
 (5,'Mang Tony Carpentry','0906 531 7742',NULL,'Pasong Camachile','General Mariano Alvarez','Cavite'),
 (6,'Kuya Joel Electrical Services','0977 349 6618','Purok 3','Canlubang','Calamba City','Laguna'),
 (7,'Dra. Maricel Pangilinan','0918 205 4476','Mabini Street','Poblacion','Santa Rosa City','Laguna'),
 (8,'Beth Tolentino Residence','0966 813 2290',NULL,'Banlic','Cabuyao City','Laguna'),
 (9,'RPG Builders & Realty','0998 457 0135','Km 54, National Highway','Parian','Calamba City','Laguna');
UPDATE customers SET customer_code = CONCAT('CUST-', LPAD(customer_id, 4, '0')), updated_at = updated_at;

INSERT INTO products (product_id, sku, product_name, unit_price, stock_quantity, reorder_level, unit) VALUES
 (1,'CM-1001','Portland Cement 40 kg',265.00,520,80,'bag'),
 (2,'CM-1004','CHB 4" (100 mm)',14.00,1450,500,'pcs'),
 (3,'CM-1006','CHB 6" (150 mm)',19.00,380,500,'pcs'),
 (4,'CM-1010','Hollow Blocks 8"',26.00,0,200,'pcs'),
 (5,'ST-2001','Rebar 10 mm x 6 m',238.00,64,100,'pcs'),
 (6,'ST-2008','GI Wire #16',98.00,42,20,'kg'),
 (7,'LB-3002','Marine Plywood 3/4" 4x8',1650.00,26,15,'sheet'),
 (8,'LB-3010','Coco Lumber 2" x 3" x 10 ft',215.00,88,40,'pcs'),
 (9,'PL-4003','PVC Pipe 1/2" x 3 m',95.00,160,60,'pcs'),
 (10,'PL-4020','Gate Valve 3/4"',285.00,12,15,'pcs'),
 (11,'EL-5001','Electrical Wire THHN 2.0 mm² (150 m)',2850.00,14,6,'roll'),
 (12,'EL-5012','Circuit Breaker 20 A',295.00,40,15,'pcs'),
 (13,'PA-6001','Roof Sealant 4 L',780.00,11,12,'pail'),
 (14,'PA-6010','Latex Paint White 4 L',890.00,28,12,'can'),
 (15,'FS-7001','Concrete Nails 3"',85.00,38,50,'kg');

-- Every product has one main category, and a few also have a second category (sample data)
INSERT INTO product_categories (product_id, category_id, is_primary) VALUES
 (1,1,1),
 (2,1,1),
 (3,1,1),
 (4,1,1),
 (5,2,1),
 (6,2,1),
 (7,3,1),
 (8,3,1),
 (9,4,1),
 (10,4,1),
 (11,5,1),
 (12,5,1),
 (13,6,1),
 (14,6,1),
 (15,7,1),
 (5,7,0),
 (6,7,0),
 (9,5,0),
 (13,4,0),
 (14,3,0),
 (15,2,0);

-- Every product has one main supplier, and a few also have a backup supplier (sample data)
INSERT INTO product_suppliers (product_id, supplier_id, is_primary) VALUES
 (1,1,1),
 (2,1,1),
 (3,1,1),
 (4,1,1),
 (5,2,1),
 (6,2,1),
 (7,3,1),
 (8,3,1),
 (9,4,1),
 (10,4,1),
 (11,5,1),
 (12,5,1),
 (13,6,1),
 (14,6,1),
 (15,2,1),
 (5,1,0),
 (6,5,0),
 (9,5,0),
 (13,3,0),
 (14,3,0);

INSERT INTO inventory_movements (movement_id, product_id, user_id, movement_type, quantity, remarks, movement_date) VALUES
 (1, 1,3,'IN', 200,'PO-2210 · Calamba Cement & Masonry Depot','2026-10-10 08:30:00'),
 (2, 7,5,'IN',  20,'PO-2214 · Imus Lumber & Plywood Center','2026-10-11 10:05:00'),
 (3, 3,3,'OUT',120,'Job site: Brgy. Pasong Camachile, General Mariano Alvarez, Cavite','2026-10-12 13:40:00'),
 (4,10,5,'OUT',  3,'Damaged in storage','2026-10-13 09:10:00'),
 (5,12,5,'IN',  24,'PO-2221 · San Pedro Electrical Supply','2026-10-14 15:22:00'),
 (6, 5,3,'OUT', 40,'Job site: Brgy. Halang, Calamba City, Laguna','2026-10-15 11:48:00'),
 (7,15,5,'IN', 100,'PO-2223 · Batangas Steel Trading Corp.','2026-10-15 14:05:00'),
 (8, 9,3,'IN',  80,'PO-2225 · Valenzuela Pipe & Fittings Supply','2026-10-16 08:20:00'),
 (9,13,3,'ADJ_OUT',2,'Count adjustment: damaged pails','2026-10-16 10:30:00'),
 (10,14,5,'ADJ_IN',1,'Count adjustment: found on shelf','2026-10-16 10:45:00');

INSERT INTO sales (sale_id, receipt_number, user_id, customer_id, customer_name, payment_method, sale_date) VALUES
 (1,'S-1001',4,1,'JM Dela Cruz Construction','Charge account','2026-10-10 09:12:00'),
 (2,'S-1002',6,NULL,'Walk-in','Cash','2026-10-11 13:40:00'),
 (3,'S-1003',4,2,'Engr. Ramon Villanueva','Bank transfer','2026-10-12 10:25:00'),
 (4,'S-1004',6,3,'Aling Lourdes Magsaysay','GCash','2026-10-12 16:05:00'),
 (5,'S-1005',4,4,'Brgy. San Antonio Captain''s Office','Charge account','2026-10-13 11:15:00'),
 (6,'S-1006',6,5,'Mang Tony Carpentry','Cash','2026-10-14 09:50:00'),
 (7,'S-1007',4,NULL,'Walk-in','Maya','2026-10-14 15:30:00'),
 (8,'S-1008',6,6,'Kuya Joel Electrical Services','GCash','2026-10-15 10:10:00'),
 (9,'S-1009',4,7,'Dra. Maricel Pangilinan','Bank transfer','2026-10-15 14:45:00'),
 (10,'S-1010',6,8,'Beth Tolentino Residence','Cash','2026-10-16 09:05:00'),
 (11,'S-1011',4,9,'RPG Builders & Realty','Charge account','2026-10-16 11:30:00');

INSERT INTO sale_items (sale_id, product_id, quantity, unit_price) VALUES
 (1,2,300,14.00),(1,1,40,265.00),
 (2,15,6,85.00),(2,6,3,98.00),
 (3,7,8,1650.00),(3,8,30,215.00),
 (4,14,2,890.00),(4,13,1,780.00),
 (5,1,60,265.00),(5,2,200,14.00),
 (6,8,40,215.00),(6,15,10,85.00),
 (7,9,12,95.00),(7,10,2,285.00),
 (8,11,2,2850.00),(8,12,10,295.00),
 (9,7,4,1650.00),(9,13,3,780.00),
 (10,14,3,890.00),(10,9,6,95.00),
 (11,1,80,265.00),(11,5,30,238.00);

-- sales.total_amount is computed from the line items (subtotal is a generated column)
UPDATE sales s SET s.total_amount = (SELECT SUM(si.subtotal) FROM sale_items si WHERE si.sale_id = s.sale_id);
-- (The foreign keys already use ON DELETE RESTRICT in the CREATE TABLE statements above.)

-- every sold item is also recorded in the stock movements as an OUT (INSERT ... SELECT)
INSERT INTO inventory_movements (product_id, user_id, movement_type, quantity, remarks, movement_date)
SELECT si.product_id, s.user_id, 'OUT', si.quantity, CONCAT('Sale ', s.receipt_number), s.sale_date
FROM sale_items si JOIN sales s ON s.sale_id = si.sale_id ORDER BY s.sale_date, si.sale_item_id;

INSERT INTO activity_logs (user_id, action, description, date_created) VALUES
 (1,'LOGIN','Signed in','2026-10-14 08:02:00'),
 (5,'STOCK_IN','Stock in: 24 × Circuit Breaker 20 A','2026-10-14 15:22:00'),
 (2,'SUPPLIER_UPDATE','Supplier updated: Batangas Steel Trading Corp.','2026-10-15 08:30:00'),
 (6,'SALE_CREATE','Sale S-1008 saved','2026-10-15 10:10:00'),
 (3,'STOCK_OUT','Stock out: 40 × Rebar 10 mm x 6 m','2026-10-15 11:48:00'),
 (4,'SALE_CREATE','Sale S-1009 saved','2026-10-15 14:45:00'),
 (1,'PRODUCT_UPDATE','Product updated: Portland Cement 40 kg','2026-10-15 16:20:00'),
 (2,'LOGIN','Signed in','2026-10-16 07:55:00'),
 (3,'STOCK_IN','Stock in: 80 × PVC Pipe 1/2" x 3 m','2026-10-16 08:20:00'),
 (6,'SALE_CREATE','Sale S-1010 saved','2026-10-16 09:05:00'),
 (3,'STOCK_ADJUST','Stock adjusted: Roof Sealant 4 L, 13 to 11 (damaged pails)','2026-10-16 10:30:00'),
 (4,'SALE_CREATE','Sale S-1011 saved','2026-10-16 11:30:00');

INSERT INTO settings (setting_id, store_name, tax_rate, reorder_level, receipt_footer) VALUES
 (1,'Stock Keeper',12.00,20,'Thank you for your purchase.');

-- =============================================================================
-- RECORD HISTORY (safe to run again): makes the history table and triggers only if they
-- don't exist yet. If your database already has data, run just this part and not the whole file
-- (the top of this file erases the existing data).
-- =============================================================================
-- RECORD HISTORY: a list of every edit, archive and restore (with the old and new values). We only add rows, never change or remove them, so we can look back later.
CREATE TABLE IF NOT EXISTS record_history (
  history_id   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  table_name   VARCHAR(30)     NOT NULL,                 -- which table: products, categories, suppliers, customers, users, settings
  record_id    INT UNSIGNED    NOT NULL,                 -- id of the record that was changed
  change_type  ENUM('UPDATE','ARCHIVE','RESTORE') NOT NULL,
  old_values   JSON            NOT NULL,                 -- how the record looked before the change (passwords are never copied)
  new_values   JSON            NOT NULL,                 -- how the record looks after the change
  changed_by   INT UNSIGNED    NULL,                     -- the employee who made the change (api.php sets this)
  changed_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_record_history PRIMARY KEY (history_id),
  CONSTRAINT fk_history_user FOREIGN KEY (changed_by) REFERENCES users (user_id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  KEY idx_history_record (table_name, record_id),
  KEY idx_history_date (changed_at)
) ENGINE=InnoDB;

DROP TRIGGER IF EXISTS trg_no_delete_record_history;
CREATE TRIGGER trg_no_delete_record_history BEFORE DELETE ON record_history FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Records are never permanently deleted. Archive the record instead.';
DROP TRIGGER IF EXISTS trg_no_update_inventory_movements;
CREATE TRIGGER trg_no_update_inventory_movements BEFORE UPDATE ON inventory_movements FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Historical records cannot be edited.';
DROP TRIGGER IF EXISTS trg_no_update_sale_items;
CREATE TRIGGER trg_no_update_sale_items BEFORE UPDATE ON sale_items FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Historical records cannot be edited.';
DROP TRIGGER IF EXISTS trg_no_update_activity_logs;
CREATE TRIGGER trg_no_update_activity_logs BEFORE UPDATE ON activity_logs FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Historical records cannot be edited.';
DROP TRIGGER IF EXISTS trg_no_update_record_history;
CREATE TRIGGER trg_no_update_record_history BEFORE UPDATE ON record_history FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Historical records cannot be edited.';

DROP TRIGGER IF EXISTS trg_hist_products;
CREATE TRIGGER trg_hist_products AFTER UPDATE ON products FOR EACH ROW
  INSERT INTO record_history (table_name, record_id, change_type, old_values, new_values, changed_by)
  SELECT 'products', OLD.product_id,
    CASE WHEN OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN 'ARCHIVE'
         WHEN OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL THEN 'RESTORE' ELSE 'UPDATE' END,
    JSON_OBJECT('sku', OLD.sku, 'product_name', OLD.product_name, 'unit_price', OLD.unit_price, 'reorder_level', OLD.reorder_level, 'unit', OLD.unit, 'archived_at', OLD.archived_at),
    JSON_OBJECT('sku', NEW.sku, 'product_name', NEW.product_name, 'unit_price', NEW.unit_price, 'reorder_level', NEW.reorder_level, 'unit', NEW.unit, 'archived_at', NEW.archived_at),
    @app_user_id
  FROM DUAL
  WHERE NOT (OLD.sku <=> NEW.sku AND OLD.product_name <=> NEW.product_name AND OLD.unit_price <=> NEW.unit_price AND OLD.reorder_level <=> NEW.reorder_level AND OLD.unit <=> NEW.unit AND OLD.archived_at <=> NEW.archived_at);
DROP TRIGGER IF EXISTS trg_hist_categories;
CREATE TRIGGER trg_hist_categories AFTER UPDATE ON categories FOR EACH ROW
  INSERT INTO record_history (table_name, record_id, change_type, old_values, new_values, changed_by)
  SELECT 'categories', OLD.category_id,
    CASE WHEN OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN 'ARCHIVE'
         WHEN OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL THEN 'RESTORE' ELSE 'UPDATE' END,
    JSON_OBJECT('category_name', OLD.category_name, 'description', OLD.description, 'archived_at', OLD.archived_at),
    JSON_OBJECT('category_name', NEW.category_name, 'description', NEW.description, 'archived_at', NEW.archived_at),
    @app_user_id
  FROM DUAL
  WHERE NOT (OLD.category_name <=> NEW.category_name AND OLD.description <=> NEW.description AND OLD.archived_at <=> NEW.archived_at);
DROP TRIGGER IF EXISTS trg_hist_suppliers;
CREATE TRIGGER trg_hist_suppliers AFTER UPDATE ON suppliers FOR EACH ROW
  INSERT INTO record_history (table_name, record_id, change_type, old_values, new_values, changed_by)
  SELECT 'suppliers', OLD.supplier_id,
    CASE WHEN OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN 'ARCHIVE'
         WHEN OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL THEN 'RESTORE' ELSE 'UPDATE' END,
    JSON_OBJECT('company_name', OLD.company_name, 'contact_person', OLD.contact_person, 'phone', OLD.phone, 'email', OLD.email, 'address', OLD.address, 'archived_at', OLD.archived_at),
    JSON_OBJECT('company_name', NEW.company_name, 'contact_person', NEW.contact_person, 'phone', NEW.phone, 'email', NEW.email, 'address', NEW.address, 'archived_at', NEW.archived_at),
    @app_user_id
  FROM DUAL
  WHERE NOT (OLD.company_name <=> NEW.company_name AND OLD.contact_person <=> NEW.contact_person AND OLD.phone <=> NEW.phone AND OLD.email <=> NEW.email AND OLD.address <=> NEW.address AND OLD.archived_at <=> NEW.archived_at);
DROP TRIGGER IF EXISTS trg_hist_customers;
CREATE TRIGGER trg_hist_customers AFTER UPDATE ON customers FOR EACH ROW
  INSERT INTO record_history (table_name, record_id, change_type, old_values, new_values, changed_by)
  SELECT 'customers', OLD.customer_id,
    CASE WHEN OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN 'ARCHIVE'
         WHEN OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL THEN 'RESTORE' ELSE 'UPDATE' END,
    JSON_OBJECT('customer_name', OLD.customer_name, 'phone', OLD.phone, 'street', OLD.street, 'barangay', OLD.barangay, 'city', OLD.city, 'province', OLD.province, 'archived_at', OLD.archived_at),
    JSON_OBJECT('customer_name', NEW.customer_name, 'phone', NEW.phone, 'street', NEW.street, 'barangay', NEW.barangay, 'city', NEW.city, 'province', NEW.province, 'archived_at', NEW.archived_at),
    @app_user_id
  FROM DUAL
  WHERE NOT (OLD.customer_name <=> NEW.customer_name AND OLD.phone <=> NEW.phone AND OLD.street <=> NEW.street AND OLD.barangay <=> NEW.barangay AND OLD.city <=> NEW.city AND OLD.province <=> NEW.province AND OLD.archived_at <=> NEW.archived_at);
DROP TRIGGER IF EXISTS trg_hist_users;
CREATE TRIGGER trg_hist_users AFTER UPDATE ON users FOR EACH ROW
  INSERT INTO record_history (table_name, record_id, change_type, old_values, new_values, changed_by)
  SELECT 'users', OLD.user_id,
    'UPDATE',
    JSON_OBJECT('full_name', OLD.full_name, 'username', OLD.username, 'email', OLD.email, 'job_title', OLD.job_title, 'phone', OLD.phone, 'status', OLD.status),
    JSON_OBJECT('full_name', NEW.full_name, 'username', NEW.username, 'email', NEW.email, 'job_title', NEW.job_title, 'phone', NEW.phone, 'status', NEW.status),
    @app_user_id
  FROM DUAL
  WHERE NOT (OLD.full_name <=> NEW.full_name AND OLD.username <=> NEW.username AND OLD.email <=> NEW.email AND OLD.job_title <=> NEW.job_title AND OLD.phone <=> NEW.phone AND OLD.status <=> NEW.status);
DROP TRIGGER IF EXISTS trg_hist_settings;
CREATE TRIGGER trg_hist_settings AFTER UPDATE ON settings FOR EACH ROW
  INSERT INTO record_history (table_name, record_id, change_type, old_values, new_values, changed_by)
  SELECT 'settings', OLD.setting_id,
    'UPDATE',
    JSON_OBJECT('store_name', OLD.store_name, 'tax_rate', OLD.tax_rate, 'reorder_level', OLD.reorder_level, 'receipt_footer', OLD.receipt_footer),
    JSON_OBJECT('store_name', NEW.store_name, 'tax_rate', NEW.tax_rate, 'reorder_level', NEW.reorder_level, 'receipt_footer', NEW.receipt_footer),
    @app_user_id
  FROM DUAL
  WHERE NOT (OLD.store_name <=> NEW.store_name AND OLD.tax_rate <=> NEW.tax_rate AND OLD.reorder_level <=> NEW.reorder_level AND OLD.receipt_footer <=> NEW.receipt_footer);