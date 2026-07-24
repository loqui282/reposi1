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
  APPMAX_ACCESS_TOKEN, // <-- cole sua chave da Appmax aqui no .env quando tiver
  BASE_URL,
  RESEND_API_KEY,
  EMAIL_FROM,
  EMAIL_TO,
  PORT,
} = process.env;

const APPMAX_BASE_URL = "https://admin.appmax.com.br/api/v3";
const resend = new Resend(RESEND_API_KEY);
const pedidosPendentes = new Map();

async function enviarEmail(pedido) {
  await resend.emails.send({
    from: EMAIL_FROM,
    to: EMAIL_TO,
    subject: `Pagamento confirmado - Pedido ${pedido.referenceId}`,
    html: `
      <h2>Novo pagamento confirmado</h2>
      <p><b>Nome:</b> ${pedido.nome}</p>
      <p><b>Email do cliente:</b> ${pedido.email}</p>
      <p><b>Telefone:</b> ${pedido.telefone || "-"}</p>
      <p><b>Valor:</b> R$ ${(pedido.valor / 100).toFixed(2)}</p>
      <p><b>Referencia:</b> ${pedido.referenceId}</p>
      <p>Envie o acesso para o cliente o quanto antes.</p>
    `,
  });
}

function cleanEnv() {
  return {
    token: String(APPMAX_ACCESS_TOKEN || "").trim(),
    baseUrl: String(APPMAX_BASE_URL).trim().replace(/\/$/, ""),
    webhookUrl: `${String(BASE_URL || "").trim().replace(/\/$/, "")}/api/webhook`,
  };
}

async function criarCliente({ nome, email, telefone }) {
  const { token, baseUrl } = cleanEnv();
  const phoneDigits = String(telefone || "").replace(/\D/g, "");

  const response = await axios.post(
    `${baseUrl}/customer`,
    {
      "access-token": token,
      firstname: String(nome).split(" ")[0] || "Cliente",
      lastname: String(nome).split(" ").slice(1).join(" ") || "Sobrenome",
      email: String(email).trim(),
      telephone: phoneDigits,
      postcode: "00000000",
      address_street: "Nao informado",
      address_street_number: "0",
      address_street_district: "Nao informado",
      address_city: "Nao informado",
      address_state: "SP",
      ip: "127.0.0.1",
    },
    { headers: { "Content-Type": "application/json" } }
  );

  return response.data?.data;
}

async function criarPedido({ customerId, valor, referenceId }) {
  const { token, baseUrl } = cleanEnv();

  const response = await axios.post(
    `${baseUrl}/order`,
    {
      "access-token": token,
      customer_id: customerId,
      products: [
        {
          sku: "acesso-produto",
          name: "Acesso ao produto",
          qty: 1,
          price: Number(valor) / 100,
        },
      ],
      shipping: 0,
      discount: 0,
      external_id: referenceId,
    },
    { headers: { "Content-Type": "application/json" } }
  );

  return response.data?.data;
}

// ---------- PIX ----------
app.post("/api/criar-pix", async (req, res) => {
  try {
    const { nome, email, telefone, valor } = req.body;

    if (!nome || !email || !valor) {
      return res.status(400).json({ erro: "nome, email e valor sao obrigatorios" });
    }

    const referenceId = `pedido_${Date.now()}`;
    const { token, baseUrl } = cleanEnv();

    const customer = await criarCliente({ nome, email, telefone });
    const order = await criarPedido({ customerId: customer.id, valor, referenceId });

    const response = await axios.post(
      `${baseUrl}/payment/pix`,
      {
        "access-token": token,
        cart: { order_id: order.id },
        customer: { customer_id: customer.id },
      },
      { headers: { "Content-Type": "application/json" } }
    );

    const pagamento = response.data?.data;
    const qrCodeImagem = pagamento?.pix_qr_code_base64 || pagamento?.qrcode || "";
    const qrCodeTexto = pagamento?.pix_emv || pagamento?.pix_code || "";

    pedidosPendentes.set(String(order.id), {
      referenceId,
      nome,
      email,
      telefone,
      valor: Number(valor),
      status: "pendente",
    });

    res.json({
      orderId: order.id,
      qrCodeImagem,
      qrCodeTexto,
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({
      erro: err.response?.data?.message || err.response?.data?.text || "Erro ao gerar PIX",
    });
  }
});

// ---------- CARTAO DE CREDITO ----------
app.post("/api/criar-cartao", async (req, res) => {
  try {
    const { nome, email, telefone, valor, cardHash, installments } = req.body;

    if (!nome || !email || !valor || !cardHash) {
      return res.status(400).json({ erro: "nome, email, valor e cardHash sao obrigatorios" });
    }

    const referenceId = `pedido_${Date.now()}`;
    const { token, baseUrl } = cleanEnv();

    const customer = await criarCliente({ nome, email, telefone });
    const order = await criarPedido({ customerId: customer.id, valor, referenceId });

    const response = await axios.post(
      `${baseUrl}/payment/credit-card`,
      {
        "access-token": token,
        cart: { order_id: order.id },
        customer: { customer_id: customer.id },
        payment: {
          CreditCard: {
            token: cardHash,
            installments: installments || 1,
          },
        },
      },
      { headers: { "Content-Type": "application/json" } }
    );

    const pagamento = response.data?.data;

    pedidosPendentes.set(String(order.id), {
      referenceId,
      nome,
      email,
      telefone,
      valor: Number(valor),
      status: pagamento?.status === "approved" ? "pago" : "pendente",
    });

    res.json({
      orderId: order.id,
      status: pagamento?.status || "pendente",
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({
      erro: err.response?.data?.message || err.response?.data?.text || "Erro ao processar cartao",
    });
  }
});

// ---------- DEBITO (via cartao com flag) ----------
app.post("/api/criar-debito", async (req, res) => {
  try {
    const { nome, email, telefone, valor, cardHash } = req.body;

    if (!nome || !email || !valor || !cardHash) {
      return res.status(400).json({ erro: "nome, email, valor e cardHash sao obrigatorios" });
    }

    const referenceId = `pedido_${Date.now()}`;
    const { token, baseUrl } = cleanEnv();

    const customer = await criarCliente({ nome, email, telefone });
    const order = await criarPedido({ customerId: customer.id, valor, referenceId });

    const response = await axios.post(
      `${baseUrl}/payment/debit-card`,
      {
        "access-token": token,
        cart: { order_id: order.id },
        customer: { customer_id: customer.id },
        payment: {
          DebitCard: {
            token: cardHash,
          },
        },
      },
      { headers: { "Content-Type": "application/json" } }
    );

    const pagamento = response.data?.data;

    pedidosPendentes.set(String(order.id), {
      referenceId,
      nome,
      email,
      telefone,
      valor: Number(valor),
      status: pagamento?.status === "approved" ? "pago" : "pendente",
    });

    res.json({
      orderId: order.id,
      status: pagamento?.status || "pendente",
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({
      erro: err.response?.data?.message || err.response?.data?.text || "Erro ao processar debito",
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
    console.log("WEBHOOK APPMAX:", JSON.stringify(req.body));

    const body = req.body || {};
    const orderId = body.data?.order_id || body.order_id || body.data?.id;
    const status = body.data?.status || body.status;

    if (orderId) {
      const pedido = pedidosPendentes.get(String(orderId));
      if (pedido && String(status).toLowerCase() === "approved") {
        pedido.status = "pago";
        pedidosPendentes.set(String(orderId), pedido);
        await enviarEmail(pedido);
      }
    }

    res.status(200).send("ok");
  } catch (err) {
    console.error(err);
    res.status(200).send("ok");
  }
});

app.get("/", (req, res) => res.send("Backend Appmax rodando."));

const port = PORT || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${port}`);
});
