const https = require("https");
const http = require("http");

const PORT = process.env.PORT || 3000;

function mtlsRequest(options, body, certPem, keyPem) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        ...options,
        cert: Buffer.from(certPem, "base64"),
        key: Buffer.from(keyPem, "base64"),
        rejectUnauthorized: false,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("Timeout")); });
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

async function getAccessToken(clientId, clientSecret, certPem, keyPem, sandbox) {
  const host = sandbox ? "baas-api-sandbox.c6bank.info" : "baas-api.c6bank.info";
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const result = await mtlsRequest(
    {
      hostname: host,
      port: 443,
      path: "/v1/auth/oauth2/token",
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    },
    "grant_type=client_credentials",
    certPem,
    keyPem
  );

  if (result.status < 200 || result.status >= 300) {
    throw new Error(`Auth C6 erro ${result.status}: ${result.body}`);
  }

  const json = JSON.parse(result.body);
  const token = json.access_token;
  if (!token) throw new Error("access_token vazio");
  return token;
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "POST" && req.url === "/boleto") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const {
          clientId, clientSecret, certPem, keyPem, sandbox,
          externalRef, amount, dueDate, payerName, payerDocument,
          payerStreet, payerNumber, payerCity, payerState, payerZip, payerEmail,
        } = data;

        if (!clientId || !clientSecret || !certPem || !keyPem) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Credenciais C6 incompletas (clientId, clientSecret, certPem, keyPem)" }));
          return;
        }
        if (!externalRef || !amount || !dueDate || !payerName || !payerDocument) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Dados do boleto incompletos" }));
          return;
        }

        const accessToken = await getAccessToken(clientId, clientSecret, certPem, keyPem, sandbox);
        const host = sandbox ? "baas-api-sandbox.c6bank.info" : "baas-api.c6bank.info";

        const boletoBody = {
          external_reference: externalRef,
          amount: parseFloat(amount),
          due_date: dueDate,
          payer: {
            name: payerName,
            document: payerDocument.replace(/\D/g, ""),
            address: {
              street: payerStreet || "",
              number: payerNumber || "",
              city: payerCity || "",
              state: payerState || "",
              zip_code: (payerZip || "").replace(/\D/g, ""),
            },
          },
        };
        if (payerEmail) boletoBody.payer.email = payerEmail;

        const boletoResult = await mtlsRequest(
          {
            hostname: host,
            port: 443,
            path: "/v1/bank_slips",
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
          },
          JSON.stringify(boletoBody),
          certPem,
          keyPem
        );

        if (boletoResult.status < 200 || boletoResult.status >= 300) {
          let errorMsg;
          try {
            errorMsg = JSON.parse(boletoResult.body).message || boletoResult.body;
          } catch {
            errorMsg = boletoResult.body;
          }
          res.writeHead(boletoResult.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `C6 API erro ${boletoResult.status}: ${errorMsg}` }));
          return;
        }

        const result = JSON.parse(boletoResult.body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            id: result.id || "",
            barcode: result.bar_code || "",
            digitableLine: result.digitable_line || "",
            dueDate: result.due_date || dueDate,
            pdfUrl: result.pdf_url || "",
          })
        );
      } catch (e) {
        console.error("Error:", e.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message || "Erro interno" }));
      }
    });
  } else if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
  } else {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }
});

server.listen(PORT, () => {
  console.log(`C6 proxy running on port ${PORT}`);
});
