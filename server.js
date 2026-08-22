const https = require("https");
const http = require("http");
const PORT = process.env.PORT || 3000;
let lastDebug = { requests: [], errors: [] };

function mtlsRequest(options, body, certPem, keyPem) {
  return new Promise((resolve, reject) => {
    const opts = { ...options, cert: Buffer.from(certPem, "base64"), key: Buffer.from(keyPem, "base64"), rejectUnauthorized: false };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("Timeout")); });
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

async function getAccessToken(clientId, clientSecret, certPem, keyPem, sandbox) {
  const host = sandbox ? "baas-api-sandbox.c6bank.info" : "baas-api.c6bank.info";
  const auth = Buffer.from(clientId + ":" + clientSecret).toString("base64");
  const result = await mtlsRequest({ hostname: host, port: 443, path: "/v1/auth", method: "POST", headers: { Authorization: "Basic " + auth, "Content-Type": "application/x-www-form-urlencoded" } }, "grant_type=client_credentials", certPem, keyPem);
  lastDebug.requests.push({ ts: new Date().toISOString(), endpoint: "auth", url: "https://" + host + "/v1/auth", status: result.status, body: result.body.substring(0, 500) });
  if (result.status < 200 || result.status >= 300) throw new Error("Auth C6 erro " + result.status + ": " + result.body);
  const json = JSON.parse(result.body);
  const token = json.access_token;
  if (!token) throw new Error("access_token vazio: " + result.body);
  return token;
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.method === "GET" && req.url === "/debug") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(lastDebug, null, 2));
    return;
  }

  if (req.method === "POST" && req.url === "/boleto-pdf") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const { clientId, clientSecret, certPem, keyPem, sandbox, boletoId } = data;
        if (!clientId || !clientSecret || !certPem || !keyPem || !boletoId) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Parametros incompletos" })); return; }
        const accessToken = await getAccessToken(clientId, clientSecret, certPem, keyPem, sandbox);
        const host = sandbox ? "baas-api-sandbox.c6bank.info" : "baas-api.c6bank.info";
        const result = await mtlsRequest({ hostname: host, port: 443, path: "/v1/bank_slips/" + boletoId + "/pdf", method: "GET", headers: { Authorization: "Bearer " + accessToken } }, null, certPem, keyPem);
        if (result.status < 200 || result.status >= 300) { res.writeHead(result.status, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Erro ao buscar PDF: " + result.status })); return; }
        res.writeHead(200, { "Content-Type": "application/pdf", "Content-Disposition": "inline; filename=boleto.pdf" });
        res.end(Buffer.from(result.body, "binary"));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  } else if (req.method === "POST" && req.url === "/boleto") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const { clientId, clientSecret, certPem, keyPem, sandbox, externalRef, amount, dueDate, payerName, payerDocument, payerStreet, payerNumber, payerCity, payerState, payerZip, payerEmail } = data;
        if (!clientId || !clientSecret || !certPem || !keyPem) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Credenciais C6 incompletas" })); return; }
        if (!externalRef || !amount || !dueDate || !payerName || !payerDocument) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Dados do boleto incompletos" })); return; }

        const accessToken = await getAccessToken(clientId, clientSecret, certPem, keyPem, sandbox);
        const host = sandbox ? "baas-api-sandbox.c6bank.info" : "baas-api.c6bank.info";

        const extRefShort = externalRef.replace(/[^a-zA-Z0-9]/g, "").substring(0, 10);
        const boletoBody = { external_reference_id: extRefShort, amount: parseFloat(amount), due_date: dueDate, payer: { name: payerName, tax_id: payerDocument.replace(/\D/g, ""), address: { street: payerStreet || "", number: parseInt(payerNumber) || 0, city: payerCity || "", state: payerState || "", zip_code: (payerZip || "").replace(/\D/g, "") } } };
        if (payerEmail) boletoBody.payer.email = payerEmail;

        lastDebug.requests.push({ ts: new Date().toISOString(), endpoint: "boleto", url: "https://" + host + "/v1/bank_slips", body: JSON.stringify(boletoBody) });

        const boletoResult = await mtlsRequest({ hostname: host, port: 443, path: "/v1/bank_slips", method: "POST", headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" } }, JSON.stringify(boletoBody), certPem, keyPem);

        lastDebug.requests.push({ ts: new Date().toISOString(), endpoint: "boleto-response", status: boletoResult.status, body: boletoResult.body.substring(0, 1000) });

        if (boletoResult.status < 200 || boletoResult.status >= 300) { let errorMsg; try { errorMsg = JSON.parse(boletoResult.body).message || JSON.parse(boletoResult.body).detail || JSON.stringify(JSON.parse(boletoResult.body)); } catch(e) { errorMsg = boletoResult.body; } lastDebug.errors.push({ ts: new Date().toISOString(), status: boletoResult.status, msg: errorMsg }); res.writeHead(boletoResult.status, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "C6 API erro " + boletoResult.status + ": " + errorMsg })); return; }

        const result = JSON.parse(boletoResult.body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, id: result.id || "", barcode: result.bar_code || "", digitableLine: result.digitable_line || "", dueDate: result.due_date || dueDate, pdfUrl: result.pdf_url || "" }));
      } catch (e) {
        lastDebug.errors.push({ ts: new Date().toISOString(), msg: e.message });
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
server.listen(PORT, () => { console.log("C6 proxy running on port " + PORT); });
