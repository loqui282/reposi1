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
  PAGBANK_TOKEN,
  PAGBANK_BASE_URL,
  BASE_URL,
  RESEND_API_KEY,
  EMAIL_FROM,
  EMAIL_TO,
  PORT,
} = process.env;

const resend = new Resend(RESEND_API_KEY);
const pedidosPendentes = new Map();

async function enviarEmail(pedido) {
  await resend.emails.send({
    from: EMAIL_FROM,
    to: EMAIL_TO,
    subject: `Pagamento confirmado - Pedido ${pedido.referenceId}`,
    html: `
      <h2>Novo pagamento confirmado via PIX</h2>
      <p><b>Nome:</b> ${pedido.nome}</p>
      <p><b>Email do cliente:</b> ${pedido.email}</p>
      <p><b>Telefone:</b> ${pedido.telefone || "-"}</p>
      <p><b>Valor:</b> R$ ${(pedido.valor / 100).toFixed(2)}</p>
      <p><b>Referencia:</b> ${pedido.referenceId}</p>
      <p>Envie o acesso para o cliente o quanto antes.</p>
    `,
  });
}

app.post("/api/criar-pix", async (req, res) => {
  try {
    const { nome, email, telefone, valor } = req.body;

    if (!nome || !email || !valor) {
      return res.status(400).json({ erro: "nome, email e valor sao obrigatorios" });
    }

    const referenceId = `pedido_${Date.now()}`;
    const phoneDigits = String(telefone || "").replace(/\D/g, "");
    const cleanBaseUrl = String(BASE_URL || "").trim().replace(/\/$/, "");
    const cleanToken = String(PAGBANK_TOKEN || "").trim();

    const response = await axios.post(
      `${PAGBANK_BASE_URL}/orders`,
      {
        reference_id: referenceId,
        customer: {
          name: String(nome).trim(),
          email: String(email).trim(),
          tax_id: "12345678909",
          phones: phoneDigits.length >= 10
            ? [
                {
                  country: "55",
                  area: phoneDigits.slice(0, 2),
                  number: phoneDigits.slice(2),
                  type: "MOBILE",
                },
              ]
            : [],
        },
        items: [
          {
            name: "Acesso ao produto",
            quantity: 1,
            unit_amount: Number(valor),
          },
        ],
        qr_codes: [
          {
            amount: { value: Number(valor) },
            expiration_date: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
            arrangements: ["PAGBANK"],
          },
        ],
        notification_urls: [`${cleanBaseUrl}/api/webhook`],
      },
      {
        headers: {
          Authorization: `Bearer ${cleanToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      }
    );

    const pedido = response.data;
    const qrCode = pedido.qr_codes?.[0];
    const qrCodeImagem = qrCode?.links?.find((l) => l.media === "image/png" || l.rel === "QRCODE.PNG")?.href;
    const qrCodeTexto = qrCode?.text || qrCode?.links?.find((l) => l.media === "text/plain" || l.rel === "QRCODE.BASE64")?.href || "";

    pedidosPendentes.set(pedido.id, {
      referenceId,
      nome,
      email,
      telefone,
      valor: Number(valor),
      status: "pendente",
    });

    res.json({
      orderId: pedido.id,
      qrCodeImagem,
      qrCodeTexto,
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ erro: err.response?.data?.error_messages?.[0]?.description || "Erro ao gerar PIX" });
  }
});

app.get("/api/status/:orderId", (req, res) => {
  const pedido = pedidosPendentes.get(req.params.orderId);
  if (!pedido) return res.status(404).json({ status: "nao_encontrado" });
  res.json({ status: pedido.status });
});

app.post("/api/webhook", async (req, res) => {
  try {
    const orderId = req.body.id || req.body.order_id;
    const charge = req.body.charges?.[0];
    const status = charge?.status;

    const pedido = pedidosPendentes.get(orderId);

    if (pedido && status === "PAID") {
      pedido.status = "pago";
      pedidosPendentes.set(orderId, pedido);
      await enviarEmail(pedido);
    }

    res.status(200).send("ok");
  } catch (err) {
    console.error(err);
    res.status(200).send("ok");
  }
});

app.get("/", (req, res) => res.send("Backend PIX rodando."));

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${port}`);
});
