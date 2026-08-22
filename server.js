const https = require("https");
const http = require("http");
const { URL } = require("url");
const PORT = process.env.PORT || 3000;
const HOST = "baas-api.c6bank.info";
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

function mtlsRequestBinary(options, body, certPem, keyPem) {
  return new Promise((resolve, reject) => {
    const opts = { ...options, cert: Buffer.from(certPem, "base64"), key: Buffer.from(keyPem, "base64"), rejectUnauthorized: false };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("Timeout")); });
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

async function getAccessToken(clientId, clientSecret, certPem, keyPem) {
  const auth = Buffer.from(clientId + ":" + clientSecret).toString("base64");
  const result = await mtlsRequest({ hostname: HOST, port: 443, path: "/v1/auth", method: "POST", headers: { Authorization: "Basic " + auth, "Content-Type": "application/x-www-form-urlencoded" } }, "grant_type=client_credentials", certPem, keyPem);
  lastDebug.requests.push({ ts: new Date().toISOString(), endpoint: "auth", status: result.status, body: (typeof result.body === "string" ? result.body : result.body.toString()).substring(0, 500) });
  if (result.status < 200 || result.status >= 300) throw new Error("Auth C6 erro " + result.status + ": " + result.body);
  const json = JSON.parse(typeof result.body === "string" ? result.body : result.body.toString());
  const token = json.access_token;
  if (!token) throw new Error("access_token vazio: " + result.body);
  return token;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
  });
}

function json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET, PUT");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.method === "GET" && req.url === "/debug") { json(res, 200, lastDebug); return; }
  if (req.method === "GET" && req.url === "/health") { json(res, 200, { status: "ok" }); return; }

  if (req.method === "POST" && req.url === "/boleto") {
    try {
      const d = await parseBody(req);
      const { clientId, clientSecret, certPem, keyPem, externalRef, amount, dueDate, payerName, payerDocument, payerStreet, payerNumber, payerCity, payerState, payerZip, payerEmail } = d;
      if (!clientId || !clientSecret || !certPem || !keyPem) return json(res, 400, { error: "Credenciais C6 incompletas" });
      if (!externalRef || !amount || !dueDate || !payerName || !payerDocument) return json(res, 400, { error: "Dados do boleto incompletos" });
      const accessToken = await getAccessToken(clientId, clientSecret, certPem, keyPem);
      const extRefShort = externalRef.replace(/[^a-zA-Z0-9]/g, "").substring(0, 10);
      const boletoBody = { external_reference_id: extRefShort, amount: parseFloat(amount), due_date: dueDate, payer: { name: payerName, tax_id: payerDocument.replace(/\D/g, ""), address: { street: payerStreet || "", number: parseInt(payerNumber) || 0, city: payerCity || "", state: payerState || "", zip_code: (payerZip || "").replace(/\D/g, "") } } };
      if (payerEmail) boletoBody.payer.email = payerEmail;
      lastDebug.requests.push({ ts: new Date().toISOString(), endpoint: "boleto", body: JSON.stringify(boletoBody) });
      const r = await mtlsRequest({ hostname: HOST, port: 443, path: "/v1/bank_slips", method: "POST", headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" } }, JSON.stringify(boletoBody), certPem, keyPem);
      const rBody = typeof r.body === "string" ? r.body : r.body.toString();
      lastDebug.requests.push({ ts: new Date().toISOString(), endpoint: "boleto-response", status: r.status, body: rBody.substring(0, 1000) });
      if (r.status < 200 || r.status >= 300) { let msg; try { const j = JSON.parse(rBody); msg = j.message || j.detail || JSON.stringify(j); } catch(e) { msg = rBody; } lastDebug.errors.push({ ts: new Date().toISOString(), status: r.status, msg }); return json(res, r.status, { error: "C6 erro " + r.status + ": " + msg }); }
      const result = JSON.parse(rBody);
      json(res, 200, { success: true, id: result.id || "", barcode: result.bar_code || "", digitableLine: result.digitable_line || "", dueDate: result.due_date || dueDate, pdfUrl: result.pdf_url || "" });
    } catch (e) { lastDebug.errors.push({ ts: new Date().toISOString(), msg: e.message }); json(res, 500, { error: e.message }); }

  } else if (req.method === "POST" && req.url === "/boleto-pdf") {
    try {
      const d = await parseBody(req);
      const { clientId, clientSecret, certPem, keyPem, boletoId } = d;
      if (!clientId || !clientSecret || !certPem || !keyPem || !boletoId) return json(res, 400, { error: "Parametros incompletos" });
      const accessToken = await getAccessToken(clientId, clientSecret, certPem, keyPem);
      const r = await mtlsRequestBinary({ hostname: HOST, port: 443, path: "/v1/bank_slips/" + boletoId + "/pdf", method: "GET", headers: { Authorization: "Bearer " + accessToken } }, null, certPem, keyPem);
      if (r.status < 200 || r.status >= 300) {
        let msg;
        try { msg = JSON.parse(r.body.toString()).detail || JSON.parse(r.body.toString()).message || r.body.toString(); } catch(e) { msg = r.body.toString(); }
        return json(res, r.status, { error: "Erro PDF: " + r.status + " " + msg });
      }
      res.writeHead(200, { "Content-Type": "application/pdf", "Content-Disposition": "inline; filename=boleto.pdf", "Content-Length": r.body.length });
      res.end(r.body);
    } catch (e) { json(res, 500, { error: e.message }); }

  } else if (req.method === "POST" && req.url === "/boleto-cancel") {
    try {
      const d = await parseBody(req);
      const { clientId, clientSecret, certPem, keyPem, boletoId } = d;
      if (!clientId || !clientSecret || !certPem || !keyPem || !boletoId) return json(res, 400, { error: "Parametros incompletos" });
      const accessToken = await getAccessToken(clientId, clientSecret, certPem, keyPem);
      lastDebug.requests.push({ ts: new Date().toISOString(), endpoint: "boleto-cancel", body: JSON.stringify({ boletoId }) });
      const r = await mtlsRequest({ hostname: HOST, port: 443, path: "/v1/bank_slips/" + boletoId + "/cancel", method: "PUT", headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" } }, null, certPem, keyPem);
      const rBody = typeof r.body === "string" ? r.body : r.body.toString();
      lastDebug.requests.push({ ts: new Date().toISOString(), endpoint: "boleto-cancel-response", status: r.status, body: rBody.substring(0, 500) });
      if (r.status < 200 || r.status >= 300) { let msg; try { msg = JSON.parse(rBody).detail || JSON.parse(rBody).message || rBody; } catch(e) { msg = rBody; } return json(res, r.status, { error: "Erro cancelar: " + r.status + " " + msg }); }
      json(res, 200, { success: true, message: "Boleto cancelado" });
    } catch (e) { lastDebug.errors.push({ ts: new Date().toISOString(), msg: e.message }); json(res, 500, { error: e.message }); }

  } else if (req.method === "POST" && req.url === "/upload-pdf") {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const boundary = "----FormBoundary" + Math.random().toString(36).substring(2);
        const pdfBuffer = Buffer.concat(chunks);
        const header = Buffer.from(
          "--" + boundary + "\r\n" +
          'Content-Disposition: form-data; name="reqtype"\r\n\r\nfileupload\r\n' +
          "--" + boundary + "\r\n" +
          'Content-Disposition: form-data; name="time"\r\n\r\n24h\r\n' +
          "--" + boundary + "\r\n" +
          'Content-Disposition: form-data; name="fileToUpload"; filename="boleto.pdf"\r\n' +
          "Content-Type: application/pdf\r\n\r\n"
        );
        const footer = Buffer.from("\r\n--" + boundary + "--\r\n");
        const body = Buffer.concat([header, pdfBuffer, footer]);
        const reqOpts = {
          hostname: "catbox.moe",
          port: 443,
          path: "/user/api.php",
          method: "POST",
          headers: { "Content-Type": "multipart/form-data; boundary=" + boundary, "Content-Length": body.length }
        };
        const proxyReq = https.request(reqOpts, (proxyRes) => {
          let data = "";
          proxyRes.on("data", (c) => (data += c));
          proxyRes.on("end", () => {
            const url = data.trim();
            if (url.startsWith("http")) {
              json(res, 200, { url: url });
            } else {
              json(res, 500, { error: "Upload falhou: " + data });
            }
          });
        });
        proxyReq.on("error", (e) => json(res, 500, { error: e.message }));
        proxyReq.write(body);
        proxyReq.end();
      } catch (e) { json(res, 500, { error: e.message }); }
    });

  } else {
    json(res, 404, { error: "Not found" });
  }
});
server.listen(PORT, () => { console.log("C6 proxy on port " + PORT); });
