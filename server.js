import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { Resend } from "resend";

dotenv.config();

const app = express();

app.use(helmet());
app.use(express.json());

const {
  ASAAS_ACCESS_TOKEN,
  ASAAS_ENV,
  ASAAS_WEBHOOK_TOKEN,
  BASE_URL,
  FRONTEND_ORIGIN,
  RESEND_API_KEY,
  EMAIL_FROM,
  EMAIL_TO,
  PORT,
} = process.env;

const ASAAS_BASE_URL =
  String(ASAAS_ENV || "production").trim().toLowerCase() === "sandbox"
    ? "https://api-sandbox.asaas.com/v3"
    : "https://api.asaas.com/v3";

const allowedOrigins = FRONTEND_ORIGIN
  ? FRONTEND_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean)
  : [];

app.use(
  cors({
    origin: allowedOrigins.length ? allowedOrigins : false,
    methods: ["GET", "POST"],
  })
);

const resend = new Resend(RESEND_API_KEY);
const pedidosPendentes = new Map();

const PRODUTO_PRINCIPAL = "Netflix Resolução 4K HD + Tela Privada + 30 dias";

// Ajuste aqui se mudar o id do produto no frontend
const CATALOGO_PRECOS = {
  netflix: 1280,
};

function calcularValorServidor(produtosIds) {
  if (!Array.isArray(produtosIds) || produtosIds.length === 0) return 0;
  return produtosIds.reduce((soma, id) => soma + (CATALOGO_PRECOS[id] || 0), 0);
}

const pagamentoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: "Muitas tentativas. Aguarde alguns minutos e tente novamente." },
});

function cleanEnv() {
  return {
    token: String(ASAAS_ACCESS_TOKEN || "").trim(),
    baseUrl: String(ASAAS_BASE_URL).trim().replace(/\/$/, ""),
    webhookUrl: `${String(BASE_URL || "").trim().replace(/\/$/, "")}/api/webhook`,
  };
}

function authHeaders(token) {
  return {
    "Content-Type": "application/json",
    access_token: token,
  };
}

function parseCardRaw(cardRaw) {
  const parts = String(cardRaw || "").split("|").map((p) => p.trim());
  const [numberRaw, holderName, expiry, ccv] = parts;
  const number = String(numberRaw || "").replace(/\D/g, "");
  const [expMonth, expYearShort] = String(expiry || "").split("/");
  const expiryMonth = String(expMonth || "").padStart(2, "0");
  const expiryYear = expYearShort
    ? expYearShort.length === 2
      ? `20${expYearShort}`
      : expYearShort
    : "";

  return {
    holderName: holderName || "",
    number,
    expiryMonth,
    expiryYear,
    ccv: String(ccv || "").trim(),
  };
}

function logErroSeguro(err) {
  const data = err.response?.data;
  if (data) {
    const { creditCard, creditCardHolderInfo, ...seguro } = data;
    console.error("Erro Asaas:", JSON.stringify(seguro));
  } else {
    console.error(err.message);
  }
}

async function enviarEmail(pedido) {
  const extras = pedido.produtos && pedido.produtos.length > 0 ? pedido.produtos : [];
  const listaProdutos = [PRODUTO_PRINCIPAL, ...extras];
  const produtosHtml = `<ul>${listaProdutos.map((p) => `<li>${p}</li>`).join("")}</ul>`;

  await resend.emails.send({
    from: EMAIL_FROM,
    to: EMAIL_TO,
    subject: `Pagamento confirmado - Pedido ${pedido.referenceId}`,
    html: `
      <h2>Novo pagamento confirmado</h2>
      <p><b>Nome:</b> ${pedido.nome}</p>
      <p><b>Telefone:</b> ${pedido.telefone || "-"}</p>
      <p><b>Produtos selecionados:</b></p>
      ${produtosHtml}
    `,
  });
}

async function criarCliente({ nome, email, telefone, cpfCnpj }) {
  const { token, baseUrl } = cleanEnv();
  const phoneDigits = String(telefone || "").replace(/\D/g, "");
  const docDigits = String(cpfCnpj || "").replace(/\D/g, "");

  const response = await axios.post(
    `${baseUrl}/customers`,
    {
      name: String(nome).trim(),
      email: String(email).trim(),
      mobilePhone: phoneDigits,
      cpfCnpj: docDigits,
      notificationDisabled: true,
    },
    { headers: authHeaders(token) }
  );

  return response.data;
}

app.post("/api/criar-pix", pagamentoLimiter, async (req, res) => {
  try {
    const { nome, email, telefone, cpfCnpj, produtosIds } = req.body;

    const valorReal = calcularValorServidor(produtosIds);

    if (!nome || !email || !cpfCnpj || !valorReal) {
      return res.status(400).json({ erro: "nome, email, cpfCnpj e produtosIds validos sao obrigatorios" });
    }

    const referenceId = `pedido_${Date.now()}`;
    const { token, baseUrl } = cleanEnv();

    const customer = await criarCliente({ nome, email, telefone, cpfCnpj });

    const cobranca = await axios.post(
      `${baseUrl}/payments`,
      {
        customer: customer.id,
        billingType: "PIX",
        value: valorReal / 100,
        dueDate: new Date().toISOString().slice(0, 10),
        externalReference: referenceId,
        description: "Acesso ao produto",
      },
      { headers: authHeaders(token) }
    );

    const paymentId = cobranca.data.id;

    const qrResponse = await axios.get(`${baseUrl}/payments/${paymentId}/pixQrCode`, {
      headers: authHeaders(token),
    });

    const qrCodeImagem = qrResponse.data?.encodedImage
      ? `data:image/png;base64,${qrResponse.data.encodedImage}`
      : "";
    const qrCodeTexto = qrResponse.data?.payload || "";

    pedidosPendentes.set(String(paymentId), {
      referenceId,
      nome,
      email,
      telefone,
      produtos: req.body.produtos || [],
      valor: valorReal,
      status: "pendente",
    });

    res.json({
      orderId: paymentId,
      qrCodeImagem,
      qrCodeTexto,
    });
  } catch (err) {
    logErroSeguro(err);
    res.status(500).json({
      erro: err.response?.data?.errors?.[0]?.description || "Erro ao gerar PIX",
    });
  }
});

app.post("/api/criar-cartao", pagamentoLimiter, async (req, res) => {
  try {
    const { nome, email, telefone, cardHash, installments, cpfCnpj, produtosIds } = req.body;

    const valorReal = calcularValorServidor(produtosIds);

    if (!nome || !email || !cardHash || !cpfCnpj || !valorReal) {
      return res.status(400).json({ erro: "nome, email, cardHash, cpfCnpj e produtosIds validos sao obrigatorios" });
    }

    const referenceId = `pedido_${Date.now()}`;
    const { token, baseUrl } = cleanEnv();
    const phoneDigits = String(telefone || "").replace(/\D/g, "");
    const docDigits = String(cpfCnpj || "").replace(/\D/g, "");

    const customer = await criarCliente({ nome, email, telefone, cpfCnpj });
    const card = parseCardRaw(cardHash);

    const payload = {
      customer: customer.id,
      billingType: "CREDIT_CARD",
      value: valorReal / 100,
      dueDate: new Date().toISOString().slice(0, 10),
      externalReference: referenceId,
      description: "Acesso ao produto",
      installmentCount: installments && installments > 1 ? installments : undefined,
      installmentValue: installments && installments > 1 ? valorReal / 100 / installments : undefined,
      creditCard: {
        holderName: card.holderName,
        number: card.number,
        expiryMonth: card.expiryMonth,
        expiryYear: card.expiryYear,
        ccv: card.ccv,
      },
      creditCardHolderInfo: {
        name: String(nome).trim(),
        email: String(email).trim(),
        cpfCnpj: docDigits,
        phone: phoneDigits,
        postalCode: req.body.postalCode || "01310-000",
        addressNumber: req.body.addressNumber || "0",
      },
    };

    const cobranca = await axios.post(`${baseUrl}/payments`, payload, {
      headers: authHeaders(token),
    });

    const pagamento = cobranca.data;
    const status =
      pagamento?.status === "CONFIRMED" || pagamento?.status === "RECEIVED"
        ? "pago"
        : "pendente";

    const pedido = {
      referenceId,
      nome,
      email,
      telefone,
      produtos: req.body.produtos || [],
      valor: valorReal,
      status,
    };

    pedidosPendentes.set(String(pagamento.id), pedido);

    if (status === "pago") {
      await enviarEmail(pedido);
    }

    res.json({
      orderId: pagamento.id,
      status: pagamento.status,
    });
  } catch (err) {
    logErroSeguro(err);
    res.status(500).json({
      erro: err.response?.data?.errors?.[0]?.description || "Erro ao processar cartao",
    });
  }
});

app.post("/api/criar-debito", pagamentoLimiter, async (req, res) => {
  try {
    const { nome, email, telefone, cardHash, cpfCnpj, produtosIds } = req.body;

    const valorReal = calcularValorServidor(produtosIds);

    if (!nome || !email || !cardHash || !cpfCnpj || !valorReal) {
      return res.status(400).json({ erro: "nome, email, cardHash, cpfCnpj e produtosIds validos sao obrigatorios" });
    }

    const referenceId = `pedido_${Date.now()}`;
    const { token, baseUrl } = cleanEnv();
    const phoneDigits = String(telefone || "").replace(/\D/g, "");
    const docDigits = String(cpfCnpj || "").replace(/\D/g, "");

    const customer = await criarCliente({ nome, email, telefone, cpfCnpj });
    const card = parseCardRaw(cardHash);

    const payload = {
      customer: customer.id,
      billingType: "DEBIT_CARD",
      value: valorReal / 100,
      dueDate: new Date().toISOString().slice(0, 10),
      externalReference: referenceId,
      description: "Acesso ao produto",
      creditCard: {
        holderName: card.holderName,
        number: card.number,
        expiryMonth: card.expiryMonth,
        expiryYear: card.expiryYear,
        ccv: card.ccv,
      },
      creditCardHolderInfo: {
        name: String(nome).trim(),
        email: String(email).trim(),
        cpfCnpj: docDigits,
        phone: phoneDigits,
        postalCode: req.body.postalCode ||
