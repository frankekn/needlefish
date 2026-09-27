import type { FixtureSpec } from "../../shared/types";

// Large-path noise control: a 27-file migration from the string logger to a
// structured event logger, with the legacy module deleted. Every call site
// keeps the information its old message carried; behavior is unchanged.
// Measures blocking noise on the map/deep/tail-coverage pipeline.
const spec: FixtureSpec = {
  id: "large-clean-sweep",
  kind: "negative",
  defectClass: "large-mechanical-sweep",
  description:
    "Clean negative: every module moves from log.<level>(message) to logger.<level>(event, fields) and the legacy logger is deleted. Output streams, debug gating, and all business logic are unchanged.",
  baseFiles: {
    "src/customers/lookup.ts": `import { log } from "../lib/log";
import { db } from "../lib/store";
import type { Customer } from "../types";

export function findCustomerByEmail(email: string): Customer | undefined {
  const normalized = email.trim().toLowerCase();
  const found = db.customers.all().find((c) => c.email === normalized);
  if (!found) {
    log.debug("customer lookup found no match");
  }
  return found;
}
`,
    "src/customers/register.ts": `import { randomUUID } from "node:crypto";
import { log } from "../lib/log";
import { db } from "../lib/store";
import type { Customer } from "../types";

export function registerCustomer(email: string, name: string): Customer {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@")) {
    throw new Error("invalid email");
  }
  if (db.customers.all().some((c) => c.email === normalized)) {
    log.warn("duplicate registration attempt");
    throw new Error("email already registered");
  }
  const customer: Customer = {
    id: randomUUID(),
    email: normalized,
    name: name.trim(),
    createdAt: new Date(),
  };
  db.customers.put(customer);
  log.info("customer " + customer.id + " registered");
  return customer;
}
`,
    "src/customers/update.ts": `import { log } from "../lib/log";
import { db } from "../lib/store";
import type { Customer } from "../types";

export interface CustomerPatch {
  readonly name?: string;
  readonly email?: string;
}

export function updateCustomer(customerId: string, patch: CustomerPatch): Customer {
  const current = db.customers.get(customerId);
  if (!current) {
    throw new Error("customer not found");
  }
  const email = patch.email === undefined ? current.email : patch.email.trim().toLowerCase();
  if (!email.includes("@")) {
    throw new Error("invalid email");
  }
  if (email !== current.email && db.customers.all().some((c) => c.email === email)) {
    throw new Error("email already registered");
  }
  const next: Customer = {
    ...current,
    email,
    name: patch.name === undefined ? current.name : patch.name.trim(),
  };
  db.customers.put(next);
  const fields = Object.keys(patch).join(",");
  log.info("customer " + customerId + " updated fields " + fields);
  return next;
}
`,
    "src/http/routes.ts": `import { log } from "../lib/log";
import { outstandingInvoices } from "../invoices/list";
import { listOrdersForCustomer } from "../orders/list";
import { endSession } from "../sessions/logout";
import { refreshSession } from "../sessions/refresh";

export interface RouteRequest {
  readonly method: string;
  readonly path: string;
  readonly sessionId: string | null;
}

export interface RouteResponse {
  readonly status: number;
  readonly body: unknown;
}

export function route(req: RouteRequest): RouteResponse {
  const session = req.sessionId === null ? null : refreshSession(req.sessionId);
  if (!session) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  try {
    if (req.method === "GET" && req.path === "/orders") {
      return { status: 200, body: listOrdersForCustomer(session.customerId) };
    }
    if (req.method === "GET" && req.path === "/invoices/outstanding") {
      return { status: 200, body: outstandingInvoices(session.customerId) };
    }
    if (req.method === "POST" && req.path === "/logout") {
      endSession(session.id);
      return { status: 204, body: null };
    }
    return { status: 404, body: { error: "not found" } };
  } catch (err) {
    log.error(req.method + " " + req.path + " failed: " + String(err));
    return { status: 500, body: { error: "internal error" } };
  }
}
`,
    "src/http/server.ts": `import { createServer, type Server } from "node:http";
import { log } from "../lib/log";
import { route } from "./routes";

export function startServer(port: number): Server {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const header = req.headers["x-session-id"];
    const result = route({
      method,
      path: url.pathname,
      sessionId: typeof header === "string" ? header : null,
    });
    res.writeHead(result.status, { "content-type": "application/json" });
    res.end(result.body === null ? "" : JSON.stringify(result.body));
    log.debug(method + " " + url.pathname + " -> " + result.status);
  });
  server.listen(port, () => {
    log.info("listening on port " + port);
  });
  return server;
}
`,
    "src/invoices/issue.ts": `import { randomUUID } from "node:crypto";
import { log } from "../lib/log";
import { db } from "../lib/store";
import type { Invoice } from "../types";

export function issueInvoice(orderId: string): Invoice {
  const order = db.orders.get(orderId);
  if (!order || order.status === "cancelled") {
    throw new Error("cannot invoice order " + orderId);
  }
  const existing = db.invoices
    .all()
    .find((inv) => inv.orderId === orderId && inv.status !== "void");
  if (existing) {
    log.info("order " + orderId + " already invoiced as " + existing.id);
    return existing;
  }
  const invoice: Invoice = {
    id: randomUUID(),
    orderId,
    customerId: order.customerId,
    amountCents: order.totalCents,
    status: "issued",
    issuedAt: new Date(),
  };
  db.invoices.put(invoice);
  log.info("invoice " + invoice.id + " issued for order " + orderId + " amount " + invoice.amountCents);
  return invoice;
}
`,
    "src/invoices/list.ts": `import { log } from "../lib/log";
import { db } from "../lib/store";
import type { Invoice } from "../types";

export function outstandingInvoices(customerId: string): Invoice[] {
  const open = db.invoices
    .all()
    .filter((inv) => inv.customerId === customerId && inv.status === "issued");
  log.debug(customerId + " has " + open.length + " outstanding invoices");
  return open;
}
`,
    "src/invoices/send.ts": `import { log } from "../lib/log";
import { db } from "../lib/store";

export type Deliver = (to: string, subject: string, body: string) => Promise<void>;

export async function sendInvoice(invoiceId: string, deliver: Deliver): Promise<boolean> {
  const invoice = db.invoices.get(invoiceId);
  if (!invoice || invoice.status !== "issued") {
    return false;
  }
  const customer = db.customers.get(invoice.customerId);
  if (!customer) {
    log.error("invoice " + invoiceId + " references missing customer " + invoice.customerId);
    return false;
  }
  const amount = (invoice.amountCents / 100).toFixed(2);
  try {
    await deliver(customer.email, "Invoice " + invoice.id, "Amount due: " + amount);
  } catch (err) {
    log.error("invoice " + invoiceId + " delivery failed: " + String(err));
    return false;
  }
  log.info("invoice " + invoiceId + " sent");
  return true;
}
`,
    "src/invoices/void.ts": `import { log } from "../lib/log";
import { db } from "../lib/store";
import type { Invoice } from "../types";

export function voidInvoice(invoiceId: string, reason: string): Invoice {
  const invoice = db.invoices.get(invoiceId);
  if (!invoice) {
    throw new Error("invoice not found");
  }
  if (invoice.status === "paid") {
    log.warn("refusing to void paid invoice " + invoiceId);
    throw new Error("paid invoices must be refunded, not voided");
  }
  const voided: Invoice = { ...invoice, status: "void" };
  db.invoices.put(voided);
  log.info("invoice " + invoiceId + " voided: " + reason);
  return voided;
}
`,
    "src/jobs/cleanup.ts": `import { log } from "../lib/log";
import { db } from "../lib/store";

export function purgeExpiredSessions(now: Date = new Date()): number {
  let removed = 0;
  for (const session of db.sessions.all()) {
    if (session.expiresAt.getTime() <= now.getTime()) {
      db.sessions.delete(session.id);
      removed += 1;
    }
  }
  log.info("purged " + removed + " expired sessions");
  return removed;
}
`,
    "src/jobs/nightly.ts": `import { log } from "../lib/log";
import { dailyOrders, type DailySummary } from "../reports/daily";
import { purgeExpiredSessions } from "./cleanup";

const DAY_MS = 24 * 60 * 60 * 1000;

export function runNightly(now: Date = new Date()): DailySummary {
  log.info("nightly run starting");
  const purged = purgeExpiredSessions(now);
  const summary = dailyOrders(new Date(now.getTime() - DAY_MS));
  log.info("nightly run finished: purged " + purged + ", orders " + summary.orderCount);
  return summary;
}
`,
    "src/lib/date-range.ts": `import { log } from "./log";

export interface DateRange {
  readonly start: Date;
  readonly end: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function dayRange(day: Date): DateRange {
  const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  const end = new Date(start.getTime() + DAY_MS);
  log.debug("day range " + start.toISOString() + " to " + end.toISOString());
  return { start, end };
}

export function monthRange(year: number, month: number): DateRange {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  log.debug("month range " + start.toISOString() + " to " + end.toISOString());
  return { start, end };
}

export function contains(range: DateRange, at: Date): boolean {
  const t = at.getTime();
  return t >= range.start.getTime() && t < range.end.getTime();
}
`,
    "src/lib/log.ts": `type Level = "debug" | "info" | "warn" | "error";

function write(level: Level, message: string): void {
  if (level === "debug" && process.env.LOG_LEVEL !== "debug") {
    return;
  }
  const line = new Date().toISOString() + " " + level.toUpperCase() + " " + message + "\\n";
  (level === "warn" || level === "error" ? process.stderr : process.stdout).write(line);
}

export const log = {
  debug: (message: string) => write("debug", message),
  info: (message: string) => write("info", message),
  warn: (message: string) => write("warn", message),
  error: (message: string) => write("error", message),
};
`,
    "src/lib/store.ts": `import type { Customer, Invoice, Order, Payment, Session } from "../types";

export class Table<T extends { readonly id: string }> {
  private readonly rows = new Map<string, T>();

  get(id: string): T | undefined {
    return this.rows.get(id);
  }

  put(row: T): void {
    this.rows.set(row.id, row);
  }

  delete(id: string): boolean {
    return this.rows.delete(id);
  }

  all(): T[] {
    return [...this.rows.values()];
  }
}

export const db = {
  customers: new Table<Customer>(),
  orders: new Table<Order>(),
  invoices: new Table<Invoice>(),
  payments: new Table<Payment>(),
  sessions: new Table<Session>(),
};
`,
    "src/orders/cancel.ts": `import { log } from "../lib/log";
import { db } from "../lib/store";
import type { Order } from "../types";

export function cancelOrder(orderId: string): Order {
  const order = db.orders.get(orderId);
  if (!order) {
    log.warn("cancel requested for missing order " + orderId);
    throw new Error("order not found");
  }
  if (order.status !== "open") {
    throw new Error("only open orders can be cancelled");
  }
  const cancelled: Order = { ...order, status: "cancelled" };
  db.orders.put(cancelled);
  log.info("order " + orderId + " cancelled");
  return cancelled;
}
`,
    "src/orders/create.ts": `import { randomUUID } from "node:crypto";
import { log } from "../lib/log";
import { db } from "../lib/store";
import type { Order } from "../types";

export function createOrder(customerId: string, totalCents: number): Order {
  if (!db.customers.get(customerId)) {
    throw new Error("unknown customer " + customerId);
  }
  if (!Number.isInteger(totalCents) || totalCents <= 0) {
    throw new Error("order total must be a positive whole number of cents");
  }
  const order: Order = {
    id: randomUUID(),
    customerId,
    status: "open",
    totalCents,
    createdAt: new Date(),
  };
  db.orders.put(order);
  log.info("order " + order.id + " created for customer " + customerId + " total " + totalCents);
  return order;
}
`,
    "src/orders/fulfil.ts": `import { log } from "../lib/log";
import { db } from "../lib/store";
import type { Order } from "../types";

export function fulfilOrder(orderId: string): Order {
  const order = db.orders.get(orderId);
  if (!order || order.status !== "open") {
    throw new Error("order is not open");
  }
  const paid = db.invoices
    .all()
    .some((inv) => inv.orderId === orderId && inv.status === "paid");
  if (!paid) {
    log.warn("order " + orderId + " has no paid invoice");
    throw new Error("order has no paid invoice");
  }
  const fulfilled: Order = { ...order, status: "fulfilled" };
  db.orders.put(fulfilled);
  log.info("order " + orderId + " fulfilled");
  return fulfilled;
}
`,
    "src/orders/list.ts": `import { log } from "../lib/log";
import { db } from "../lib/store";
import type { Order } from "../types";

export function listOrdersForCustomer(customerId: string): Order[] {
  const orders = db.orders
    .all()
    .filter((o) => o.customerId === customerId)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  log.debug("listed " + orders.length + " orders for customer " + customerId);
  return orders;
}
`,
    "src/payments/capture.ts": `import { log } from "../lib/log";
import { db } from "../lib/store";
import type { Payment } from "../types";
import type { Gateway } from "./gateway";

export async function capturePayment(paymentId: string, gateway: Gateway): Promise<Payment> {
  const payment = db.payments.get(paymentId);
  if (!payment || payment.status !== "authorized") {
    throw new Error("payment is not capturable");
  }
  try {
    await gateway.capture(payment.id, payment.amountCents);
  } catch (err) {
    log.error("capture failed for payment " + paymentId + ": " + String(err));
    throw err;
  }
  const captured: Payment = { ...payment, status: "captured" };
  db.payments.put(captured);
  const invoice = db.invoices.get(payment.invoiceId);
  if (invoice && payment.amountCents >= invoice.amountCents) {
    db.invoices.put({ ...invoice, status: "paid" });
  }
  log.info("payment " + paymentId + " captured " + payment.amountCents);
  return captured;
}
`,
    "src/payments/gateway.ts": `export interface Gateway {
  capture(paymentId: string, amountCents: number): Promise<void>;
  refund(paymentId: string, amountCents: number): Promise<void>;
  listRefundedPaymentIds(): Promise<readonly string[]>;
}
`,
    "src/payments/reconcile.ts": `import { log } from "../lib/log";
import { db } from "../lib/store";
import type { Gateway } from "./gateway";

export async function reconcileRefunds(gateway: Gateway): Promise<number> {
  const refundedIds = new Set(await gateway.listRefundedPaymentIds());
  let updated = 0;
  for (const payment of db.payments.all()) {
    if (payment.status === "captured" && refundedIds.has(payment.id)) {
      db.payments.put({ ...payment, status: "refunded" });
      updated += 1;
    }
  }
  log.info("reconciled " + updated + " refunds from gateway");
  return updated;
}
`,
    "src/payments/refund.ts": `import { log } from "../lib/log";
import { db } from "../lib/store";
import type { Payment } from "../types";
import type { Gateway } from "./gateway";

export async function refundPayment(paymentId: string, gateway: Gateway): Promise<Payment> {
  const payment = db.payments.get(paymentId);
  if (!payment || payment.status !== "captured") {
    throw new Error("payment is not refundable");
  }
  await gateway.refund(payment.id, payment.amountCents);
  const refunded: Payment = { ...payment, status: "refunded" };
  db.payments.put(refunded);
  log.info("payment " + paymentId + " refunded " + payment.amountCents);
  return refunded;
}
`,
    "src/reports/daily.ts": `import { log } from "../lib/log";
import { contains, dayRange } from "../lib/date-range";
import { db } from "../lib/store";

export interface DailySummary {
  readonly day: string;
  readonly orderCount: number;
  readonly totalCents: number;
}

export function dailyOrders(day: Date): DailySummary {
  const range = dayRange(day);
  const key = range.start.toISOString().slice(0, 10);
  const orders = db.orders
    .all()
    .filter((o) => o.status !== "cancelled" && contains(range, o.createdAt));
  const totalCents = orders.reduce((sum, o) => sum + o.totalCents, 0);
  log.info("daily orders " + key + ": " + orders.length + " totalling " + totalCents);
  return { day: key, orderCount: orders.length, totalCents };
}
`,
    "src/reports/export.ts": `import { log } from "../lib/log";
import { monthlyRevenue } from "./monthly";

export function monthlyCsv(year: number, month: number): string {
  const summary = monthlyRevenue(year, month);
  const row = [
    summary.year,
    summary.month,
    summary.invoiceCount,
    (summary.totalCents / 100).toFixed(2),
  ].join(",");
  log.debug("exported monthly csv " + year + "-" + month);
  return "year,month,invoices,total\\n" + row + "\\n";
}
`,
    "src/reports/monthly.ts": `import { log } from "../lib/log";
import { contains, monthRange } from "../lib/date-range";
import { db } from "../lib/store";

export interface MonthlySummary {
  readonly year: number;
  readonly month: number;
  readonly invoiceCount: number;
  readonly totalCents: number;
}

export function monthlyRevenue(year: number, month: number): MonthlySummary {
  const range = monthRange(year, month);
  const invoices = db.invoices
    .all()
    .filter(
      (inv) => inv.status !== "void" && inv.issuedAt !== null && contains(range, inv.issuedAt),
    );
  const totalCents = invoices.reduce((sum, inv) => sum + inv.amountCents, 0);
  log.info("monthly revenue " + year + "-" + month + ": " + invoices.length + " invoices totalling " + totalCents);
  return { year, month, invoiceCount: invoices.length, totalCents };
}
`,
    "src/sessions/login.ts": `import { randomBytes } from "node:crypto";
import { log } from "../lib/log";
import { db } from "../lib/store";
import type { Session } from "../types";

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export function startSession(customerId: string, now: Date = new Date()): Session {
  if (!db.customers.get(customerId)) {
    throw new Error("unknown customer");
  }
  const session: Session = {
    id: randomBytes(32).toString("hex"),
    customerId,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
  };
  db.sessions.put(session);
  log.info("session started for customer " + customerId);
  return session;
}
`,
    "src/sessions/logout.ts": `import { log } from "../lib/log";
import { db } from "../lib/store";

export function endSession(sessionId: string): void {
  const session = db.sessions.get(sessionId);
  if (!session) {
    return;
  }
  db.sessions.delete(sessionId);
  log.info("session ended for customer " + session.customerId);
}
`,
    "src/sessions/refresh.ts": `import { log } from "../lib/log";
import { db } from "../lib/store";
import type { Session } from "../types";
import { SESSION_TTL_MS } from "./login";

export function refreshSession(sessionId: string, now: Date = new Date()): Session | null {
  const session = db.sessions.get(sessionId);
  if (!session || session.expiresAt.getTime() <= now.getTime()) {
    log.debug("refresh rejected for unknown or expired session");
    return null;
  }
  const refreshed: Session = {
    ...session,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
  };
  db.sessions.put(refreshed);
  log.debug("session refreshed for customer " + session.customerId);
  return refreshed;
}
`,
    "src/types.ts": `export interface Customer {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly createdAt: Date;
}

export interface Order {
  readonly id: string;
  readonly customerId: string;
  readonly status: "open" | "fulfilled" | "cancelled";
  readonly totalCents: number;
  readonly createdAt: Date;
}

export interface Invoice {
  readonly id: string;
  readonly orderId: string;
  readonly customerId: string;
  readonly amountCents: number;
  readonly status: "issued" | "paid" | "void";
  readonly issuedAt: Date | null;
}

export interface Payment {
  readonly id: string;
  readonly invoiceId: string;
  readonly amountCents: number;
  readonly status: "authorized" | "captured" | "refunded";
}

export interface Session {
  readonly id: string;
  readonly customerId: string;
  readonly expiresAt: Date;
}
`,
  },
  deletedFiles: ["src/lib/log.ts"],
  headFiles: {
    "src/customers/lookup.ts": `import { logger } from "../lib/logger";
import { db } from "../lib/store";
import type { Customer } from "../types";

export function findCustomerByEmail(email: string): Customer | undefined {
  const normalized = email.trim().toLowerCase();
  const found = db.customers.all().find((c) => c.email === normalized);
  if (!found) {
    logger.debug("customer.lookup_miss");
  }
  return found;
}
`,
    "src/customers/register.ts": `import { randomUUID } from "node:crypto";
import { logger } from "../lib/logger";
import { db } from "../lib/store";
import type { Customer } from "../types";

export function registerCustomer(email: string, name: string): Customer {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@")) {
    throw new Error("invalid email");
  }
  if (db.customers.all().some((c) => c.email === normalized)) {
    logger.warn("customer.duplicate");
    throw new Error("email already registered");
  }
  const customer: Customer = {
    id: randomUUID(),
    email: normalized,
    name: name.trim(),
    createdAt: new Date(),
  };
  db.customers.put(customer);
  logger.info("customer.registered", { customerId: customer.id });
  return customer;
}
`,
    "src/customers/update.ts": `import { logger } from "../lib/logger";
import { db } from "../lib/store";
import type { Customer } from "../types";

export interface CustomerPatch {
  readonly name?: string;
  readonly email?: string;
}

export function updateCustomer(customerId: string, patch: CustomerPatch): Customer {
  const current = db.customers.get(customerId);
  if (!current) {
    throw new Error("customer not found");
  }
  const email = patch.email === undefined ? current.email : patch.email.trim().toLowerCase();
  if (!email.includes("@")) {
    throw new Error("invalid email");
  }
  if (email !== current.email && db.customers.all().some((c) => c.email === email)) {
    throw new Error("email already registered");
  }
  const next: Customer = {
    ...current,
    email,
    name: patch.name === undefined ? current.name : patch.name.trim(),
  };
  db.customers.put(next);
  const fields = Object.keys(patch).join(",");
  logger.info("customer.updated", { customerId, fields });
  return next;
}
`,
    "src/http/routes.ts": `import { logger } from "../lib/logger";
import { outstandingInvoices } from "../invoices/list";
import { listOrdersForCustomer } from "../orders/list";
import { endSession } from "../sessions/logout";
import { refreshSession } from "../sessions/refresh";

export interface RouteRequest {
  readonly method: string;
  readonly path: string;
  readonly sessionId: string | null;
}

export interface RouteResponse {
  readonly status: number;
  readonly body: unknown;
}

export function route(req: RouteRequest): RouteResponse {
  const session = req.sessionId === null ? null : refreshSession(req.sessionId);
  if (!session) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  try {
    if (req.method === "GET" && req.path === "/orders") {
      return { status: 200, body: listOrdersForCustomer(session.customerId) };
    }
    if (req.method === "GET" && req.path === "/invoices/outstanding") {
      return { status: 200, body: outstandingInvoices(session.customerId) };
    }
    if (req.method === "POST" && req.path === "/logout") {
      endSession(session.id);
      return { status: 204, body: null };
    }
    return { status: 404, body: { error: "not found" } };
  } catch (err) {
    logger.error("http.request_failed", {
      method: req.method,
      path: req.path,
      error: String(err),
    });
    return { status: 500, body: { error: "internal error" } };
  }
}
`,
    "src/http/server.ts": `import { createServer, type Server } from "node:http";
import { logger } from "../lib/logger";
import { route } from "./routes";

export function startServer(port: number): Server {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const header = req.headers["x-session-id"];
    const result = route({
      method,
      path: url.pathname,
      sessionId: typeof header === "string" ? header : null,
    });
    res.writeHead(result.status, { "content-type": "application/json" });
    res.end(result.body === null ? "" : JSON.stringify(result.body));
    logger.debug("http.request", {
      method,
      path: url.pathname,
      status: result.status,
    });
  });
  server.listen(port, () => {
    logger.info("http.listening", { port });
  });
  return server;
}
`,
    "src/invoices/issue.ts": `import { randomUUID } from "node:crypto";
import { logger } from "../lib/logger";
import { db } from "../lib/store";
import type { Invoice } from "../types";

export function issueInvoice(orderId: string): Invoice {
  const order = db.orders.get(orderId);
  if (!order || order.status === "cancelled") {
    throw new Error("cannot invoice order " + orderId);
  }
  const existing = db.invoices
    .all()
    .find((inv) => inv.orderId === orderId && inv.status !== "void");
  if (existing) {
    logger.info("invoice.already_issued", { orderId, invoiceId: existing.id });
    return existing;
  }
  const invoice: Invoice = {
    id: randomUUID(),
    orderId,
    customerId: order.customerId,
    amountCents: order.totalCents,
    status: "issued",
    issuedAt: new Date(),
  };
  db.invoices.put(invoice);
  logger.info("invoice.issued", {
    invoiceId: invoice.id,
    orderId,
    amountCents: invoice.amountCents,
  });
  return invoice;
}
`,
    "src/invoices/list.ts": `import { logger } from "../lib/logger";
import { db } from "../lib/store";
import type { Invoice } from "../types";

export function outstandingInvoices(customerId: string): Invoice[] {
  const open = db.invoices
    .all()
    .filter((inv) => inv.customerId === customerId && inv.status === "issued");
  logger.debug("invoice.outstanding", { customerId, count: open.length });
  return open;
}
`,
    "src/invoices/send.ts": `import { logger } from "../lib/logger";
import { db } from "../lib/store";

export type Deliver = (to: string, subject: string, body: string) => Promise<void>;

export async function sendInvoice(invoiceId: string, deliver: Deliver): Promise<boolean> {
  const invoice = db.invoices.get(invoiceId);
  if (!invoice || invoice.status !== "issued") {
    return false;
  }
  const customer = db.customers.get(invoice.customerId);
  if (!customer) {
    logger.error("invoice.send_no_customer", {
      invoiceId,
      customerId: invoice.customerId,
    });
    return false;
  }
  const amount = (invoice.amountCents / 100).toFixed(2);
  try {
    await deliver(customer.email, "Invoice " + invoice.id, "Amount due: " + amount);
  } catch (err) {
    logger.error("invoice.send_failed", { invoiceId, error: String(err) });
    return false;
  }
  logger.info("invoice.sent", { invoiceId });
  return true;
}
`,
    "src/invoices/void.ts": `import { logger } from "../lib/logger";
import { db } from "../lib/store";
import type { Invoice } from "../types";

export function voidInvoice(invoiceId: string, reason: string): Invoice {
  const invoice = db.invoices.get(invoiceId);
  if (!invoice) {
    throw new Error("invoice not found");
  }
  if (invoice.status === "paid") {
    logger.warn("invoice.void_refused", { invoiceId });
    throw new Error("paid invoices must be refunded, not voided");
  }
  const voided: Invoice = { ...invoice, status: "void" };
  db.invoices.put(voided);
  logger.info("invoice.voided", { invoiceId, reason });
  return voided;
}
`,
    "src/jobs/cleanup.ts": `import { logger } from "../lib/logger";
import { db } from "../lib/store";

export function purgeExpiredSessions(now: Date = new Date()): number {
  let removed = 0;
  for (const session of db.sessions.all()) {
    if (session.expiresAt.getTime() <= now.getTime()) {
      db.sessions.delete(session.id);
      removed += 1;
    }
  }
  logger.info("job.sessions_purged", { removed });
  return removed;
}
`,
    "src/jobs/nightly.ts": `import { logger } from "../lib/logger";
import { dailyOrders, type DailySummary } from "../reports/daily";
import { purgeExpiredSessions } from "./cleanup";

const DAY_MS = 24 * 60 * 60 * 1000;

export function runNightly(now: Date = new Date()): DailySummary {
  logger.info("job.nightly_started");
  const purged = purgeExpiredSessions(now);
  const summary = dailyOrders(new Date(now.getTime() - DAY_MS));
  logger.info("job.nightly_finished", { purged, orders: summary.orderCount });
  return summary;
}
`,
    "src/lib/date-range.ts": `import { logger } from "./logger";

export interface DateRange {
  readonly start: Date;
  readonly end: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function dayRange(day: Date): DateRange {
  const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  const end = new Date(start.getTime() + DAY_MS);
  logger.debug("date_range.day", {
    start: start.toISOString(),
    end: end.toISOString(),
  });
  return { start, end };
}

export function monthRange(year: number, month: number): DateRange {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  logger.debug("date_range.month", {
    start: start.toISOString(),
    end: end.toISOString(),
  });
  return { start, end };
}

export function contains(range: DateRange, at: Date): boolean {
  const t = at.getTime();
  return t >= range.start.getTime() && t < range.end.getTime();
}
`,
    "src/lib/logger.ts": `export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Readonly<Record<string, string | number | boolean | null>>;

function write(level: LogLevel, event: string, fields: LogFields): void {
  if (level === "debug" && process.env.LOG_LEVEL !== "debug") {
    return;
  }
  const line = JSON.stringify({ ...fields, time: new Date().toISOString(), level, event }) + "\\n";
  (level === "warn" || level === "error" ? process.stderr : process.stdout).write(line);
}

export const logger = {
  debug: (event: string, fields: LogFields = {}) => write("debug", event, fields),
  info: (event: string, fields: LogFields = {}) => write("info", event, fields),
  warn: (event: string, fields: LogFields = {}) => write("warn", event, fields),
  error: (event: string, fields: LogFields = {}) => write("error", event, fields),
};
`,
    "src/orders/cancel.ts": `import { logger } from "../lib/logger";
import { db } from "../lib/store";
import type { Order } from "../types";

export function cancelOrder(orderId: string): Order {
  const order = db.orders.get(orderId);
  if (!order) {
    logger.warn("order.cancel_missing", { orderId });
    throw new Error("order not found");
  }
  if (order.status !== "open") {
    throw new Error("only open orders can be cancelled");
  }
  const cancelled: Order = { ...order, status: "cancelled" };
  db.orders.put(cancelled);
  logger.info("order.cancelled", { orderId });
  return cancelled;
}
`,
    "src/orders/create.ts": `import { randomUUID } from "node:crypto";
import { logger } from "../lib/logger";
import { db } from "../lib/store";
import type { Order } from "../types";

export function createOrder(customerId: string, totalCents: number): Order {
  if (!db.customers.get(customerId)) {
    throw new Error("unknown customer " + customerId);
  }
  if (!Number.isInteger(totalCents) || totalCents <= 0) {
    throw new Error("order total must be a positive whole number of cents");
  }
  const order: Order = {
    id: randomUUID(),
    customerId,
    status: "open",
    totalCents,
    createdAt: new Date(),
  };
  db.orders.put(order);
  logger.info("order.created", { orderId: order.id, customerId, totalCents });
  return order;
}
`,
    "src/orders/fulfil.ts": `import { logger } from "../lib/logger";
import { db } from "../lib/store";
import type { Order } from "../types";

export function fulfilOrder(orderId: string): Order {
  const order = db.orders.get(orderId);
  if (!order || order.status !== "open") {
    throw new Error("order is not open");
  }
  const paid = db.invoices
    .all()
    .some((inv) => inv.orderId === orderId && inv.status === "paid");
  if (!paid) {
    logger.warn("order.fulfil_unpaid", { orderId });
    throw new Error("order has no paid invoice");
  }
  const fulfilled: Order = { ...order, status: "fulfilled" };
  db.orders.put(fulfilled);
  logger.info("order.fulfilled", { orderId });
  return fulfilled;
}
`,
    "src/orders/list.ts": `import { logger } from "../lib/logger";
import { db } from "../lib/store";
import type { Order } from "../types";

export function listOrdersForCustomer(customerId: string): Order[] {
  const orders = db.orders
    .all()
    .filter((o) => o.customerId === customerId)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  logger.debug("order.listed", { customerId, count: orders.length });
  return orders;
}
`,
    "src/payments/capture.ts": `import { logger } from "../lib/logger";
import { db } from "../lib/store";
import type { Payment } from "../types";
import type { Gateway } from "./gateway";

export async function capturePayment(paymentId: string, gateway: Gateway): Promise<Payment> {
  const payment = db.payments.get(paymentId);
  if (!payment || payment.status !== "authorized") {
    throw new Error("payment is not capturable");
  }
  try {
    await gateway.capture(payment.id, payment.amountCents);
  } catch (err) {
    logger.error("payment.capture_failed", { paymentId, error: String(err) });
    throw err;
  }
  const captured: Payment = { ...payment, status: "captured" };
  db.payments.put(captured);
  const invoice = db.invoices.get(payment.invoiceId);
  if (invoice && payment.amountCents >= invoice.amountCents) {
    db.invoices.put({ ...invoice, status: "paid" });
  }
  logger.info("payment.captured", {
    paymentId,
    invoiceId: payment.invoiceId,
    amountCents: payment.amountCents,
  });
  return captured;
}
`,
    "src/payments/reconcile.ts": `import { logger } from "../lib/logger";
import { db } from "../lib/store";
import type { Gateway } from "./gateway";

export async function reconcileRefunds(gateway: Gateway): Promise<number> {
  const refundedIds = new Set(await gateway.listRefundedPaymentIds());
  let updated = 0;
  for (const payment of db.payments.all()) {
    if (payment.status === "captured" && refundedIds.has(payment.id)) {
      db.payments.put({ ...payment, status: "refunded" });
      updated += 1;
    }
  }
  logger.info("payment.refunds_reconciled", { updated });
  return updated;
}
`,
    "src/payments/refund.ts": `import { logger } from "../lib/logger";
import { db } from "../lib/store";
import type { Payment } from "../types";
import type { Gateway } from "./gateway";

export async function refundPayment(paymentId: string, gateway: Gateway): Promise<Payment> {
  const payment = db.payments.get(paymentId);
  if (!payment || payment.status !== "captured") {
    throw new Error("payment is not refundable");
  }
  await gateway.refund(payment.id, payment.amountCents);
  const refunded: Payment = { ...payment, status: "refunded" };
  db.payments.put(refunded);
  logger.info("payment.refunded", { paymentId, amountCents: payment.amountCents });
  return refunded;
}
`,
    "src/reports/daily.ts": `import { logger } from "../lib/logger";
import { contains, dayRange } from "../lib/date-range";
import { db } from "../lib/store";

export interface DailySummary {
  readonly day: string;
  readonly orderCount: number;
  readonly totalCents: number;
}

export function dailyOrders(day: Date): DailySummary {
  const range = dayRange(day);
  const key = range.start.toISOString().slice(0, 10);
  const orders = db.orders
    .all()
    .filter((o) => o.status !== "cancelled" && contains(range, o.createdAt));
  const totalCents = orders.reduce((sum, o) => sum + o.totalCents, 0);
  logger.info("report.daily", { day: key, orders: orders.length, totalCents });
  return { day: key, orderCount: orders.length, totalCents };
}
`,
    "src/reports/export.ts": `import { logger } from "../lib/logger";
import { monthlyRevenue } from "./monthly";

export function monthlyCsv(year: number, month: number): string {
  const summary = monthlyRevenue(year, month);
  const row = [
    summary.year,
    summary.month,
    summary.invoiceCount,
    (summary.totalCents / 100).toFixed(2),
  ].join(",");
  logger.debug("report.exported", { year, month });
  return "year,month,invoices,total\\n" + row + "\\n";
}
`,
    "src/reports/monthly.ts": `import { logger } from "../lib/logger";
import { contains, monthRange } from "../lib/date-range";
import { db } from "../lib/store";

export interface MonthlySummary {
  readonly year: number;
  readonly month: number;
  readonly invoiceCount: number;
  readonly totalCents: number;
}

export function monthlyRevenue(year: number, month: number): MonthlySummary {
  const range = monthRange(year, month);
  const invoices = db.invoices
    .all()
    .filter(
      (inv) => inv.status !== "void" && inv.issuedAt !== null && contains(range, inv.issuedAt),
    );
  const totalCents = invoices.reduce((sum, inv) => sum + inv.amountCents, 0);
  logger.info("report.monthly", {
    year,
    month,
    invoices: invoices.length,
    totalCents,
  });
  return { year, month, invoiceCount: invoices.length, totalCents };
}
`,
    "src/sessions/login.ts": `import { randomBytes } from "node:crypto";
import { logger } from "../lib/logger";
import { db } from "../lib/store";
import type { Session } from "../types";

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export function startSession(customerId: string, now: Date = new Date()): Session {
  if (!db.customers.get(customerId)) {
    throw new Error("unknown customer");
  }
  const session: Session = {
    id: randomBytes(32).toString("hex"),
    customerId,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
  };
  db.sessions.put(session);
  logger.info("session.started", { customerId });
  return session;
}
`,
    "src/sessions/logout.ts": `import { logger } from "../lib/logger";
import { db } from "../lib/store";

export function endSession(sessionId: string): void {
  const session = db.sessions.get(sessionId);
  if (!session) {
    return;
  }
  db.sessions.delete(sessionId);
  logger.info("session.ended", { customerId: session.customerId });
}
`,
    "src/sessions/refresh.ts": `import { logger } from "../lib/logger";
import { db } from "../lib/store";
import type { Session } from "../types";
import { SESSION_TTL_MS } from "./login";

export function refreshSession(sessionId: string, now: Date = new Date()): Session | null {
  const session = db.sessions.get(sessionId);
  if (!session || session.expiresAt.getTime() <= now.getTime()) {
    logger.debug("session.refresh_rejected");
    return null;
  }
  const refreshed: Session = {
    ...session,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
  };
  db.sessions.put(refreshed);
  logger.debug("session.refreshed", { customerId: session.customerId });
  return refreshed;
}
`,
  },
  expected: {
    verdict: "pass",
    noBlockingFindings: true,
  },
};

export default spec;
