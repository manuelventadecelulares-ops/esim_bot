
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const { v4: uuidv4 } = require("uuid");

const TelegramBot = require("node-telegram-bot-api");
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const { MercadoPagoConfig, Preference } = require('mercadopago');

const client = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN
});

const preference = new Preference(client);


const app = express();
app.use(express.json());

const ADMIN_ID = String(process.env.ADMIN_ID || "");
const BASE_URL = process.env.BASE_URL;

// -------------------- STOCK (archivo) --------------------
const STOCK_FILE = path.join(__dirname, "stock.json");

function loadStock() {
  if (!fs.existsSync(STOCK_FILE)) return {};
  return JSON.parse(fs.readFileSync(STOCK_FILE, "utf-8"));
}

function saveStock(stock) {
  fs.writeFileSync(STOCK_FILE, JSON.stringify(stock, null, 2), "utf-8");
}

function popStockItem(sku) {
  const stock = loadStock();
  const list = stock[sku] || [];
  if (list.length === 0) return null;
  const item = list.shift(); // toma el primero
  stock[sku] = list;
  saveStock(stock);
  return item;
}

// -------------------- “DB” simple de órdenes --------------------
const ORDERS_FILE = path.join(__dirname, "orders.json");

function loadOrders() {
  if (!fs.existsSync(ORDERS_FILE)) return {};
  return JSON.parse(fs.readFileSync(ORDERS_FILE, "utf-8"));
}

function saveOrders(orders) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2), "utf-8");
}

function createOrder({ chatId, sku, title, price }) {
  const orders = loadOrders();
  const orderId = uuidv4();
  orders[orderId] = {
    orderId,
    chatId,
    sku,
    title,
    price,
    status: "pending",
    createdAt: Date.now()
  };
  saveOrders(orders);
  return orders[orderId];
}

function updateOrder(orderId, patch) {
  const orders = loadOrders();
  if (!orders[orderId]) return null;
  orders[orderId] = { ...orders[orderId], ...patch };
  saveOrders(orders);
  return orders[orderId];
}

// -------------------- MENÚ PRINCIPAL --------------------
function mainMenu(chatId) {
  bot.sendMessage(chatId, "📲 *eSIM Global Store*\n\nElige una opción:", {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🇲🇽 eSIM México", callback_data: "MX_MENU" }],
        [{ text: "🇺🇸 eSIM USA", callback_data: "USA_MENU" }],
        [{ text: "🧩 eSIM Bug", callback_data: "BUG" }],
        [{ text: "🧑‍💻 Soporte", callback_data: "SOPORTE" }],
        [{ text: "📲 WhatsApp 5640025348", callback_data: "WA" }],
        [{ text: "🕒 Horario 8am–1am", callback_data: "HORARIO" }],
        [{ text: "🔓 Liberaciones (próximamente)", callback_data: "LIB" }]
      ]
    }
  });
}

bot.onText(/\/start/, (msg) => {
  mainMenu(msg.chat.id);
});

// -------------------- SUBMENÚS --------------------
function mxMenu(chatId) {
  bot.sendMessage(chatId, "🇲🇽 *eSIM México*\nElige tu LADA:", {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "CDMX (56) — $100 con saldo", callback_data: "MX_ATT_56_100" }],
        [{ text: "Otras LADAS — $150 con saldo", callback_data: "MX_ATT_OTHER_150" }],
        [{ text: "↩️ Volver al menú", callback_data: "MENU" }]
      ]
    }
  });
}

function usaMenu(chatId) {
  bot.sendMessage(chatId, "🇺🇸 *eSIM USA*\nElige compañía:", {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "AT&T USA — $200 con saldo", callback_data: "USA_ATT_200" }],
        [{ text: "T-Mobile — $200 con saldo", callback_data: "USA_TMO_200" }],
        [{ text: "↩️ Volver al menú", callback_data: "MENU" }]
      ]
    }
  });
}

// -------------------- RESUMEN + BOTÓN PAGAR --------------------
async function showSummary(chatId, selection) {
  const { sku, title, price } = selection;
  bot.sendMessage(
    chatId,
    `✅ *Selección:*\n${title}\n\n💰 *Total:* $${price}\n\n🧾 *Esta eSIM incluye saldo.*\n\nPresiona *Pagar* para continuar.`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "💳 Pagar", callback_data: `PAY:${sku}` }],
          [{ text: "↩️ Volver al menú", callback_data: "MENU" }]
        ]
      }
    }
  );
}

// -------------------- MERCADOPAGO (crear link) --------------------
async function createMpLink(order) {
  if (!BASE_URL) throw new Error("Falta BASE_URL en .env (URL pública).");

  const preference = {
    items: [
      {
        title: order.title,
        quantity: 1,
        unit_price: Number(order.price),
        currency_id: "MXN"
      }
    ],
    external_reference: order.orderId,
    notification_url: `${BASE_URL}/mp/webhook`,
    // Opcional: si quieres que al pagar los regrese a algo
    back_urls: {
      success: "https://t.me/",
      failure: "https://t.me/",
      pending: "https://t.me/"
    },
    auto_return: "approved"
  };

  const res = await mercadopago.preferences.create(preference);
  return res.body.init_point; // link
}

// -------------------- WEBHOOK MERCADOPAGO --------------------
app.post("/mp/webhook", async (req, res) => {
  try {
    // MercadoPago manda distintos formatos. Normalmente viene "data.id"
    const paymentId = req.body?.data?.id || req.body?.id;
    if (!paymentId) return res.sendStatus(200);

    const payment = await mercadopago.payment.findById(paymentId);
    const status = payment.body.status;
    const orderId = payment.body.external_reference;

    if (!orderId) return res.sendStatus(200);

    if (status === "approved") {
      const order = updateOrder(orderId, { status: "approved", paymentId });

      // Entrega del stock
      const item = popStockItem(order.sku);
      if (!item) {
        bot.sendMessage(order.chatId, "✅ Pago aprobado, pero *no hay stock* disponible. Te contacto para entregarte.", { parse_mode: "Markdown" });
        return res.sendStatus(200);
      }

      const filePath = path.join(__dirname, item.file);
      await bot.sendMessage(order.chatId, "✅ *Pago aprobado.* Aquí tienes tu eSIM:", { parse_mode: "Markdown" });
      await bot.sendPhoto(order.chatId, filePath, { caption: "📲 Escanea el QR para instalar tu eSIM." });

      await bot.sendMessage(order.chatId, "🧾 *Nota:* Pregunta disponibilidad antes de pagar.\n\n¿Necesitas ayuda con la instalación? Presiona *Soporte*.", { parse_mode: "Markdown" });
    }

    return res.sendStatus(200);
  } catch (e) {
    return res.sendStatus(200);
  }
});

// -------------------- CALLBACKS (botones) --------------------
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const data = q.data;

  try {
    if (data === "MENU") return mainMenu(chatId);
    if (data === "MX_MENU") return mxMenu(chatId);
    if (data === "USA_MENU") return usaMenu(chatId);

    if (data === "HORARIO") return bot.sendMessage(chatId, "🕒 Horario: *8:00am a 1:00am*", { parse_mode: "Markdown" });
    if (data === "WA") return bot.sendMessage(chatId, "📲 WhatsApp: *5640025348*", { parse_mode: "Markdown" });
    if (data === "SOPORTE") return bot.sendMessage(chatId, "🧑‍💻 Soporte:\nMándame captura + modelo de iPhone/Android y tu duda.");
    if (data === "LIB") return bot.sendMessage(chatId, "🔓 Liberaciones: *próximamente*.", { parse_mode: "Markdown" });
    if (data === "BUG") return bot.sendMessage(chatId, "🧩 eSIM Bug: *próximamente*.", { parse_mode: "Markdown" });

    // Selecciones directas (por ahora)
    if (data === "MX_ATT_56_100") {
      return showSummary(chatId, { sku: "MX_ATT_56_100", title: "🇲🇽 AT&T México — CDMX (56)", price: 100 });
    }
    if (data === "MX_ATT_OTHER_150") {
      return showSummary(chatId, { sku: "MX_ATT_OTHER_150", title: "🇲🇽 AT&T México — Otras LADAS", price: 150 });
    }
    if (data === "USA_ATT_200") {
      return showSummary(chatId, { sku: "USA_ATT_200", title: "🇺🇸 AT&T USA", price: 200 });
    }
    if (data === "USA_TMO_200") {
      return showSummary(chatId, { sku: "USA_TMO_200", title: "🇺🇸 T-Mobile", price: 200 });
    }

    // Pagar
    if (data.startsWith("PAY:")) {
      const sku = data.split(":")[1];

      // define título/precio por sku
      const map = {
        MX_ATT_56_100: { title: "eSIM AT&T México CDMX (56) $100", price: 100 },
        MX_ATT_OTHER_150: { title: "eSIM AT&T México Otras LADAS $150", price: 150 },
        USA_ATT_200: { title: "eSIM AT&T USA $200", price: 200 },
        USA_TMO_200: { title: "eSIM T-Mobile $200", price: 200 }
      };

      const sel = map[sku];
      if (!sel) return bot.sendMessage(chatId, "SKU inválido.");

      const order = createOrder({ chatId, sku, title: sel.title, price: sel.price });
      const link = await createMpLink(order);

      return bot.sendMessage(chatId, "💳 Listo. Paga aquí y se confirma automático:", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Pagar ahora", url: link }],
            [{ text: "↩️ Volver al menú", callback_data: "MENU" }]
          ]
        }
      });
    }
  } finally {
    // quita “loading” del botón
    bot.answerCallbackQuery(q.id).catch(() => {});
  }
});

// -------------------- SERVER (para webhook) --------------------
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => res.send("OK"));
app.listen(PORT, () => console.log("Webhook server on", PORT));
