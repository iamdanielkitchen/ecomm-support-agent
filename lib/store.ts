import { readFileSync } from "node:fs";
import { join } from "node:path";

export type CatalogItem = {
  sku: string;
  name: string;
  price: number;
  final_sale: boolean;
};

export type Customer = {
  email: string;
  name: string;
};

export type OrderItem = {
  sku: string;
  quantity: number;
  opened: boolean;
  returned: boolean;
};

export type OrderStatus =
  | "placed"
  | "in_transit"
  | "delivered"
  | "lost_in_transit"
  | "refused_at_delivery";

export type Order = {
  order_number: string;
  customer_email: string;
  placed_at: string; // YYYY-MM-DD
  delivered_at: string | null; // YYYY-MM-DD or null
  status: OrderStatus;
  shipping_method: "standard" | "expedited";
  items: OrderItem[];
  total: number;
};

export type Return = {
  rma: string;
  order_number: string;
  item_sku: string;
  reason: string;
  reason_note?: string;
  fee_usd: number;
  created_at: string; // ISO
};

export type StoreData = {
  customers: Customer[];
  catalog: CatalogItem[];
  orders: Order[];
  returns: Return[];
};

// Load once per process. In-memory mutations (e.g., initiate_return) persist
// for the process lifetime but are not flushed to disk — the fake store is a
// fixture, not a database. Process restart = fresh fixture.
let _store: StoreData | null = null;

export function getStore(): StoreData {
  if (_store) return _store;
  const path = join(process.cwd(), "data", "store.json");
  const raw = readFileSync(path, "utf-8");
  _store = JSON.parse(raw) as StoreData;
  return _store;
}

// Exposed for the eval harness so it can reset state between cases.
export function reloadStore(): StoreData {
  _store = null;
  return getStore();
}

export function findOrder(orderNumber: string): Order | undefined {
  return getStore().orders.find((o) => o.order_number === orderNumber);
}

export function findCatalogItem(sku: string): CatalogItem | undefined {
  return getStore().catalog.find((c) => c.sku === sku);
}
