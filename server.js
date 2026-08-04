import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import { Resend } from "resend";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const {
  ASAAS_ACCESS_TOKEN, // <-- cole sua chave da Asaas aqui no .env quando tiver
  ASAAS_ENV, // "sandbox" ou "production"
  BASE_URL,
  RESEND_API_KEY,
  EMAIL_FROM,
  EMAIL_TO,
  PORT,
} = process.env;

const ASAAS_BASE_URL =
  String(ASAAS_ENV || "production").trim().toLowerCase() === "sandbox"
    ? "https://api-sandbox.asaas.com/v3"
    : "https://api.asaas.com/v3";

const resend = new Resend(RESEND_API_KEY);
const pedidosPendentes = new Map();

const PRODUTO_PRINCIPAL = "Netflix Resolução 4K HD + Tela Privada + 30 dias";

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

// Divide uma string "NUMERO|NOME|MM/AA|CVV" em campos separados
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

// ---------- PIX ----------
app.post("/api/criar-pix", async (req, res) => {
  try {
    const { nome, email, telefone, valor, cpfCnpj, produtos } = req.body;

    if (!nome || !email || !valor || !cpfCnpj) {
      return res.status(400).json({ erro: "nome, email, valor e cpfCnpj sao obrigatorios" });
    }

    const referenceId = `pedido_${Date.now()}`;
    const { token, baseUrl } = cleanEnv();

    const customer = await criarCliente({ nome, email, telefone, cpfCnpj });

    const cobranca = await axios.post(
      `${baseUrl}/payments`,
      {
        customer: customer.id,
        billingType: "PIX",
        value: Number(valor) / 100,
        dueDate: new Date().toISOString().slice(0, 10),
        externalReference: referenceId,
        description: "Acesso ao produto",
      },
      { headers: authHeaders(token) }
    );

    const paymentId = cobranca.data.id;

    const qrResponse = await axios.get(
      `${baseUrl}/payments/${paymentId}/pixQrCode`,
      { headers: authHeaders(token) }
    );

    const qrCodeImagem = qrResponse.data?.encodedImage
      ? `data:image/png;base64,${qrResponse.data.encodedImage}`
      : "";
    const qrCodeTexto = qrResponse.data?.payload || "";

    pedidosPendentes.set(String(paymentId), {
      referenceId,
      nome,
      email,
      telefone,
      produtos: produtos || [],
      valor: Number(valor),
      status: "pendente",
    });

    res.json({
      orderId: paymentId,
      qrCodeImagem,
      qrCodeTexto,
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({
      erro: err.response?.data?.errors?.[0]?.description || "Erro ao gerar PIX",
    });
  }
});

// ---------- CARTAO DE CREDITO ----------
app.post("/api/criar-cartao", async (req, res) => {
  try {
    const { nome, email, telefone, valor, cardHash, installments, cpfCnpj, produtos } = req.body;

    if (!nome || !email || !valor || !cardHash || !cpfCnpj) {
      return res.status(400).json({ erro: "nome, email, valor, cardHash e cpfCnpj sao obrigatorios" });
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
      value: Number(valor) / 100,
      dueDate: new Date().toISOString().slice(0, 10),
      externalReference: referenceId,
      description: "Acesso ao produto",
      installmentCount: installments && installments > 1 ? installments : undefined,
      installmentValue:
        installments && installments > 1
          ? Number(valor) / 100 / installments
          : undefined,
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
    const status = pagamento?.status === "CONFIRMED" || pagamento?.status === "RECEIVED"
      ? "pago"
      : "pendente";

    const pedido = {
      referenceId,
      nome,
      email,
      telefone,
      produtos: produtos || [],
      valor: Number(valor),
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
    console.error(err.response?.data || err.message);
    res.status(500).json({
      erro: err.response?.data?.errors?.[0]?.description || "Erro ao processar cartao",
    });
  }
});

// ---------- DEBITO ----------
app.post("/api/criar-debito", async (req, res) => {
  try {
    const { nome, email, telefone, valor, cardHash, cpfCnpj, produtos } = req.body;

    if (!nome || !email || !valor || !cardHash || !cpfCnpj) {
      return res.status(400).json({ erro: "nome, email, valor, cardHash e cpfCnpj sao obrigatorios" });
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
      value: Number(valor) / 100,
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
        postalCode: req.body.postalCode || "01310-000",
        addressNumber: req.body.addressNumber || "0",
      },
    };

    const cobranca = await axios.post(`${baseUrl}/payments`, payload, {
      headers: authHeaders(token),
    });

    const pagamento = cobranca.data;
    const status = pagamento?.status === "CONFIRMED" || pagamento?.status === "RECEIVED"
      ? "pago"
      : "pendente";

    const pedido = {
      referenceId,
      nome,
      email,
      telefone,
      produtos: produtos || [],
      valor: Number(valor),
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
    console.error(err.response?.data || err.message);
    res.status(500).json({
      erro: err.response?.data?.errors?.[0]?.description || "Erro ao processar debito",
    });
  }
});

app.get("/api/status/:orderId", (req, res) => {
  const pedido = pedidosPendentes.get(String(req.params.orderId));
  if (!pedido) return res.status(404).json({ status: "nao_encontrado" });
  res.json({ status: pedido.status });
});

app.post("/api/webhook", async (req, res) => {
  try {
    console.log("WEBHOOK ASAAS:", JSON.stringify(req.body));

    const body = req.body || {};
    const evento = body.event;
    const payment = body.payment || {};
    const paymentId = payment.id;
    const status = payment.status;

    if (paymentId) {
      const pedido = pedidosPendentes.get(String(paymentId));
      const statusPago = ["PAYMENT_CONFIRMED", "PAYMENT_RECEIVED"].includes(evento) ||
        ["CONFIRMED", "RECEIVED"].includes(status);

      if (pedido && statusPago && pedido.status !== "pago") {
        pedido.status = "pago";
        pedidosPendentes.set(String(paymentId), pedido);
        await enviarEmail(pedido);
      }
    }

    res.status(200).send("ok");
  } catch (err) {
    console.error(err);
    res.status(200).send("ok");
  }
});

app.get("/", (req, res) => res.send("Backend Asaas rodando."));

const port = PORT || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${port}`);
});
