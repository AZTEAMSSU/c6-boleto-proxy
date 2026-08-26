const https = require("https");
const http = require("http");
const crypto = require("crypto");
const PORT = process.env.PORT || 3000;
const HOST = "baas-api.c6bank.info";
let lastDebug = { requests: [], errors: [] };
const sharedPdfs = {};
const infinitePayStore = {};

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

function generateExtRef26() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < 26; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of Object.entries(sharedPdfs)) {
    if (now - v.ts > 24 * 60 * 60 * 1000) delete sharedPdfs[k];
  }
}, 60 * 60 * 1000);

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET, PUT");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.method === "GET" && req.url === "/debug") { json(res, 200, lastDebug); return; }
  if (req.method === "GET" && req.url === "/health") { json(res, 200, { status: "ok" }); return; }

  if (req.method === "POST" && req.url === "/shorten") {
    try {
      const d = await parseBody(req);
      const { url } = d;
      if (!url) return json(res, 400, { error: "url obrigatório" });

      async function shortenShortIo(longUrl) {
        const body = JSON.stringify({ originalURL: longUrl, domain: "l0vmwb.s.gy" });
        const opts = { hostname: "api.short.io", path: "/links", method: "POST", headers: { "Content-Type": "application/json", "Authorization": "sk_rqgbHvKWT8mMSxjz", "Content-Length": Buffer.byteLength(body) } };
        return new Promise((resolve, reject) => {
          const r = https.request(opts, (res2) => { let d = ""; res2.on("data", c => d += c); res2.on("end", () => resolve({ status: res2.statusCode, body: d })); });
          r.on("error", reject); r.write(body); r.end();
        });
      }

      async function shortenLinkly(longUrl) {
        const body = JSON.stringify({ workspace_id: 396757, url: longUrl });
        const opts = { hostname: "app.linklyhq.com", path: "/api/v1/link?api_key=LxsOD4ydSXpiCkPCyGR9vg==", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } };
        return new Promise((resolve, reject) => {
          const r = https.request(opts, (res2) => { let d = ""; res2.on("data", c => d += c); res2.on("end", () => resolve({ status: res2.statusCode, body: d })); });
          r.on("error", reject); r.write(body); r.end();
        });
      }

      try {
        const r1 = await shortenShortIo(url);
        if (r1.status >= 200 && r1.status < 300) {
          const p = JSON.parse(r1.body);
          if (p.shortURL) return json(res, 200, { shortUrl: p.shortURL });
        }
      } catch (e) {}

      try {
        const r2 = await shortenLinkly(url);
        if (r2.status >= 200 && r2.status < 300) {
          const p = JSON.parse(r2.body);
          if (p.full_url) return json(res, 200, { shortUrl: p.full_url });
        }
      } catch (e) {}

      json(res, 200, { shortUrl: url });
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/shared/")) {
    const token = req.url.split("/shared/")[1];
    const entry = sharedPdfs[token];
    if (!entry) { res.writeHead(404); res.end("Not found or expired"); return; }
    res.writeHead(200, { "Content-Type": "application/pdf", "Content-Disposition": "inline; filename=boleto.pdf", "Content-Length": entry.data.length });
    res.end(entry.data);
    return;
  }

  if (req.method === "POST" && req.url === "/boleto") {
    try {
      const d = await parseBody(req);
      const { clientId, clientSecret, certPem, keyPem, externalRef, amount, dueDate, description, payerName, payerDocument, payerStreet, payerCity, payerState, payerZip, payerEmail, boletoMode } = d;
      if (!clientId || !clientSecret || !certPem || !keyPem) return json(res, 400, { error: "Credenciais C6 incompletas" });
      if (!amount || !dueDate || !payerName || !payerDocument) return json(res, 400, { error: "Dados do boleto incompletos" });
      const accessToken = await getAccessToken(clientId, clientSecret, certPem, keyPem);

      if (boletoMode === "v2") {
        const extRef = generateExtRef26();
        const boletoBody = {
          external_reference_id: extRef,
          amount: parseFloat(amount),
          due_date: dueDate,
          description: description || "Boleto Gerenciador AzTeam",
          payer: {
            name: payerName,
            tax_id: payerDocument.replace(/\D/g, ""),
            address: {
              address: payerStreet || "",
              neighborhood: "N/D",
              city: payerCity || "",
              state: payerState || "",
              zip_code: (payerZip || "").replace(/\D/g, "")
            }
          },
          payment_method: {
            bank_slip: {
              billing_scheme: "15"
            }
          }
        };
        if (payerEmail) boletoBody.payer.email = payerEmail;

        lastDebug.requests.push({ ts: new Date().toISOString(), endpoint: "boleto-v2", body: JSON.stringify(boletoBody) });
        const r = await mtlsRequest({ hostname: HOST, port: 443, path: "/v2/bank_slips", method: "POST", headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json", "partner-software-name": "Gerenciador AzTeam", "partner-software-version": "2.0" } }, JSON.stringify(boletoBody), certPem, keyPem);
        const rBody = typeof r.body === "string" ? r.body : r.body.toString();
        lastDebug.requests.push({ ts: new Date().toISOString(), endpoint: "boleto-v2-response", status: r.status, body: rBody.substring(0, 2000) });
        if (r.status < 200 || r.status >= 300) { let msg; try { const j = JSON.parse(rBody); msg = j.message || j.detail || JSON.stringify(j); } catch(e) { msg = rBody; } lastDebug.errors.push({ ts: new Date().toISOString(), status: r.status, msg }); return json(res, r.status, { error: "C6 erro " + r.status + ": " + msg }); }
        const result = JSON.parse(rBody);
        let pixEmv = "", pixQrUrl = "";
        if (result.payment_method && result.payment_method.pix) {
          pixEmv = result.payment_method.pix.qr_code || "";
          pixQrUrl = result.payment_method.pix.image_content || "";
        }
        const bs = result.payment_method && result.payment_method.bank_slip;
        json(res, 200, { success: true, id: extRef, barcode: bs ? bs.bar_code || "" : "", digitableLine: bs ? bs.digitable_line || "" : "", dueDate: result.due_date || dueDate, pdfUrl: "", pixEmv, pixQrUrl, externalRef: extRef, boletoMode: "v2" });
      } else {
        const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        const extRefV1 = externalRef ? externalRef.replace(/[^a-zA-Z0-9]/g, "").substring(0, 10) : Array.from({length: 10}, () => chars[Math.floor(Math.random() * chars.length)]).join("");
        const boletoBody = { external_reference_id: extRefV1, amount: parseFloat(amount), due_date: dueDate, billing_scheme: "15", payer: { name: payerName, tax_id: payerDocument.replace(/\D/g, ""), address: { street: payerStreet || "", number: 0, city: payerCity || "", state: payerState || "", zip_code: (payerZip || "").replace(/\D/g, "") } } };
        if (payerEmail) boletoBody.payer.email = payerEmail;

        lastDebug.requests.push({ ts: new Date().toISOString(), endpoint: "boleto-v1", body: JSON.stringify(boletoBody) });
        const r = await mtlsRequest({ hostname: HOST, port: 443, path: "/v1/bank_slips", method: "POST", headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" } }, JSON.stringify(boletoBody), certPem, keyPem);
        const rBody = typeof r.body === "string" ? r.body : r.body.toString();
        lastDebug.requests.push({ ts: new Date().toISOString(), endpoint: "boleto-v1-response", status: r.status, body: rBody.substring(0, 2000) });
        if (r.status < 200 || r.status >= 300) { let msg; try { const j = JSON.parse(rBody); msg = j.message || j.detail || JSON.stringify(j); } catch(e) { msg = rBody; } lastDebug.errors.push({ ts: new Date().toISOString(), status: r.status, msg }); return json(res, r.status, { error: "C6 erro " + r.status + ": " + msg }); }
        const result = JSON.parse(rBody);
        json(res, 200, { success: true, id: result.id || "", barcode: result.bar_code || "", digitableLine: result.digitable_line || "", dueDate: result.due_date || dueDate, pdfUrl: result.pdf_url || "", pixEmv: result.emv || result.pix_copia_e_cola || "", pixQrUrl: result.qrcode_url || result.base64 || "", externalRef: result.id || extRefV1, boletoMode: "v1" });
      }
    } catch (e) { lastDebug.errors.push({ ts: new Date().toISOString(), msg: e.message }); json(res, 500, { error: e.message }); }

  } else if (req.method === "POST" && req.url === "/boleto-pdf") {
    try {
      const d = await parseBody(req);
      const { clientId, clientSecret, certPem, keyPem, externalRef, boletoMode } = d;
      if (!clientId || !clientSecret || !certPem || !keyPem || !externalRef) return json(res, 400, { error: "Parametros incompletos" });
      const accessToken = await getAccessToken(clientId, clientSecret, certPem, keyPem);
      const apiPath = boletoMode === "v2" ? "/v2/bank_slips/" + externalRef + "/pdf" : "/v1/bank_slips/" + externalRef + "/pdf";
      const headers = { Authorization: "Bearer " + accessToken };
      if (boletoMode === "v2") { headers["partner-software-name"] = "Gerenciador AzTeam"; headers["partner-software-version"] = "2.0"; }
      const r = await mtlsRequestBinary({ hostname: HOST, port: 443, path: apiPath, method: "GET", headers }, null, certPem, keyPem);
      if (r.status < 200 || r.status >= 300) {
        let msg;
        try { msg = JSON.parse(r.body.toString()).detail || JSON.parse(r.body.toString()).message || r.body.toString(); } catch(e) { msg = r.body.toString(); }
        return json(res, r.status, { error: "Erro PDF: " + r.status + " " + msg });
      }
      res.writeHead(200, { "Content-Type": "application/pdf", "Content-Disposition": "inline; filename=boleto.pdf", "Content-Length": r.body.length });
      res.end(r.body);
    } catch (e) { json(res, 500, { error: e.message }); }

  } else if (req.method === "POST" && req.url === "/share-pdf") {
    try {
      const d = await parseBody(req);
      const { clientId, clientSecret, certPem, keyPem, externalRef, boletoMode } = d;
      if (!clientId || !clientSecret || !certPem || !keyPem || !externalRef) return json(res, 400, { error: "Parametros incompletos" });
      const accessToken = await getAccessToken(clientId, clientSecret, certPem, keyPem);
      const apiPath = boletoMode === "v2" ? "/v2/bank_slips/" + externalRef + "/pdf" : "/v1/bank_slips/" + externalRef + "/pdf";
      const headers = { Authorization: "Bearer " + accessToken };
      if (boletoMode === "v2") { headers["partner-software-name"] = "Gerenciador AzTeam"; headers["partner-software-version"] = "2.0"; }
      const r = await mtlsRequestBinary({ hostname: HOST, port: 443, path: apiPath, method: "GET", headers }, null, certPem, keyPem);
      if (r.status < 200 || r.status >= 300) {
        let msg;
        try { msg = JSON.parse(r.body.toString()).detail || r.body.toString(); } catch(e) { msg = r.body.toString(); }
        return json(res, r.status, { error: "Erro PDF: " + r.status + " " + msg });
      }
      const token = crypto.randomBytes(16).toString("hex");
      sharedPdfs[token] = { data: r.body, ts: Date.now() };
      const baseUrl = "https://c6-boleto-proxy.onrender.com";
      json(res, 200, { url: baseUrl + "/shared/" + token });
    } catch (e) { json(res, 500, { error: e.message }); }

  } else if (req.method === "POST" && req.url === "/boleto-cancel") {
    try {
      const d = await parseBody(req);
      const { clientId, clientSecret, certPem, keyPem, externalRef, boletoMode } = d;
      if (!clientId || !clientSecret || !certPem || !keyPem || !externalRef) return json(res, 400, { error: "Parametros incompletos" });
      const accessToken = await getAccessToken(clientId, clientSecret, certPem, keyPem);
      const apiPath = boletoMode === "v2" ? "/v2/bank_slips/" + externalRef + "/cancel" : "/v1/bank_slips/" + externalRef + "/cancel";
      const headers = { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" };
      if (boletoMode === "v2") { headers["partner-software-name"] = "Gerenciador AzTeam"; headers["partner-software-version"] = "2.0"; }
      lastDebug.requests.push({ ts: new Date().toISOString(), endpoint: "boleto-cancel", body: JSON.stringify({ externalRef, boletoMode }) });
      const r = await mtlsRequest({ hostname: HOST, port: 443, path: apiPath, method: "PUT", headers }, null, certPem, keyPem);
      const rBody = typeof r.body === "string" ? r.body : r.body.toString();
      lastDebug.requests.push({ ts: new Date().toISOString(), endpoint: "boleto-cancel-response", status: r.status, body: rBody.substring(0, 500) });
      if (r.status < 200 || r.status >= 300) { let msg; try { msg = JSON.parse(rBody).detail || JSON.parse(rBody).message || rBody; } catch(e) { msg = rBody; } return json(res, r.status, { error: "Erro cancelar: " + r.status + " " + msg }); }
      json(res, 200, { success: true, message: "Boleto cancelado" });
    } catch (e) { lastDebug.errors.push({ ts: new Date().toISOString(), msg: e.message }); json(res, 500, { error: e.message }); }

  } else if (req.method === "POST" && req.url === "/boleto-status") {
    try {
      const d = await parseBody(req);
      const { clientId, clientSecret, certPem, keyPem, externalRef, boletoMode } = d;
      if (!clientId || !clientSecret || !certPem || !keyPem || !externalRef) return json(res, 400, { error: "Parametros incompletos" });
      const accessToken = await getAccessToken(clientId, clientSecret, certPem, keyPem);
      let apiPath;
      if (boletoMode === "v2") {
        apiPath = "/v2/bank_slips/" + externalRef;
      } else {
        apiPath = "/v1/bank_slips/" + externalRef;
      }
      const headers = { Authorization: "Bearer " + accessToken };
      if (boletoMode === "v2") { headers["partner-software-name"] = "Gerenciador AzTeam"; headers["partner-software-version"] = "2.0"; }
      const r = await mtlsRequest({ hostname: HOST, port: 443, path: apiPath, method: "GET", headers }, null, certPem, keyPem);
      const rBody = typeof r.body === "string" ? r.body : r.body.toString();
      lastDebug.requests.push({ ts: new Date().toISOString(), endpoint: "boleto-status", status: r.status, body: rBody.substring(0, 1000) });
      if (r.status < 200 || r.status >= 300) { let msg; try { msg = JSON.parse(rBody).detail || JSON.parse(rBody).message || rBody; } catch(e) { msg = rBody; } return json(res, r.status, { error: "Erro consultar: " + r.status + " " + msg }); }
      const result = JSON.parse(rBody);
      json(res, 200, { success: true, status: result.status || "UNKNOWN", paid: result.status === "PAID", data: result });
    } catch (e) { lastDebug.errors.push({ ts: new Date().toISOString(), msg: e.message }); json(res, 500, { error: e.message }); }

  } else if (req.method === "POST" && req.url === "/boleto-resend-email") {
    try {
      const d = await parseBody(req);
      const { clientId, clientSecret, certPem, keyPem, externalRef, boletoMode } = d;
      if (!clientId || !clientSecret || !certPem || !keyPem || !externalRef) return json(res, 400, { error: "Parametros incompletos" });
      const accessToken = await getAccessToken(clientId, clientSecret, certPem, keyPem);
      const apiPath = boletoMode === "v2" ? "/v2/bank_slips/" + externalRef + "/send-email" : "/v1/bank_slips/" + externalRef + "/send-email";
      const headers = { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" };
      if (boletoMode === "v2") { headers["partner-software-name"] = "Gerenciador AzTeam"; headers["partner-software-version"] = "2.0"; }
      lastDebug.requests.push({ ts: new Date().toISOString(), endpoint: "boleto-resend-email", body: JSON.stringify({ externalRef, boletoMode }) });
      const r = await mtlsRequest({ hostname: HOST, port: 443, path: apiPath, method: "PUT", headers }, null, certPem, keyPem);
      const rBody = typeof r.body === "string" ? r.body : r.body.toString();
      lastDebug.requests.push({ ts: new Date().toISOString(), endpoint: "boleto-resend-email-response", status: r.status, body: rBody.substring(0, 500) });
      if (r.status < 200 || r.status >= 300) { let msg; try { msg = JSON.parse(rBody).detail || JSON.parse(rBody).message || rBody; } catch(e) { msg = rBody; } return json(res, r.status, { error: "Erro reenviar email: " + r.status + " " + msg }); }
      json(res, 200, { success: true, message: "Email reenviado" });
    } catch (e) { lastDebug.errors.push({ ts: new Date().toISOString(), msg: e.message }); json(res, 500, { error: e.message }); }

  } else if (req.method === "POST" && req.url === "/pagbank") {
    try {
      const d = await parseBody(req);
      const { token, env, method, path, body } = d;
      if (!token) return json(res, 400, { error: "Token PagBank obrigatorio" });
      const baseUrl = env === "sandbox" ? "https://sandbox.api.pagseguro.com" : "https://api.pagseguro.com";
      const targetPath = path || "/orders";
      const opts = {
        hostname: baseUrl.replace("https://", ""),
        port: 443,
        path: targetPath,
        method: method || "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + token
        }
      };
      const result = await new Promise((resolve, reject) => {
        const r = https.request(opts, (res2) => {
          let data = "";
          res2.on("data", (c) => data += c);
          res2.on("end", () => resolve({ status: res2.statusCode, body: data }));
        });
        r.on("error", reject);
        r.setTimeout(30000, () => { r.destroy(); reject(new Error("Timeout")); });
        if (body) r.write(typeof body === "string" ? body : JSON.stringify(body));
        r.end();
      });
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(result.body);
    } catch (e) { json(res, 500, { error: e.message }); }

  } else if (req.method === "POST" && req.url === "/mercadopago") {
    try {
      const d = await parseBody(req);
      const { token, method, path, body } = d;
      if (!token) return json(res, 400, { error: "Token Mercado Pago obrigatorio" });
      const targetPath = path || "/v1/payments";
      const opts = {
        hostname: "api.mercadopago.com",
        port: 443,
        path: targetPath,
        method: method || "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + token,
          "X-Idempotency-Key": "pix_" + Date.now() + "_" + Math.random().toString(36).slice(2,10)
        }
      };
      const result = await new Promise((resolve, reject) => {
        const r = https.request(opts, (res2) => {
          let data = "";
          res2.on("data", (c) => data += c);
          res2.on("end", () => resolve({ status: res2.statusCode, body: data }));
        });
        r.on("error", reject);
        r.setTimeout(30000, () => { r.destroy(); reject(new Error("Timeout")); });
        if (body) r.write(typeof body === "string" ? body : JSON.stringify(body));
        r.end();
      });
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(result.body);
    } catch (e) { json(res, 500, { error: e.message }); }

  } else if (req.method === "POST" && req.url === "/infinitepay-create") {
    try {
      const d = await parseBody(req);
      const { handle, items, order_nsu, redirect_url, webhook_url } = d;
      if (!handle) return json(res, 400, { error: "handle obrigatorio" });
      if (!items || !items.length) return json(res, 400, { error: "items obrigatorio" });
      const payload = { handle, items, order_nsu: order_nsu || ("order_" + Date.now()) };
      if (redirect_url) payload.redirect_url = redirect_url;
      if (webhook_url) payload.webhook_url = webhook_url;
      const bodyStr = JSON.stringify(payload);
      const opts = {
        hostname: "api.checkout.infinitepay.io",
        port: 443,
        path: "/links",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) }
      };
      const result = await new Promise((resolve, reject) => {
        const r = https.request(opts, (res2) => {
          let data = "";
          res2.on("data", (c) => data += c);
          res2.on("end", () => resolve({ status: res2.statusCode, body: data }));
        });
        r.on("error", reject);
        r.setTimeout(30000, () => { r.destroy(); reject(new Error("Timeout")); });
        r.write(bodyStr);
        r.end();
      });
      lastDebug.requests.push({ ts: new Date().toISOString(), endpoint: "infinitepay-create", status: result.status, body: result.body.substring(0, 1000) });
      if (result.status < 200 || result.status >= 300) {
        return json(res, result.status, { error: "InfinityPay erro " + result.status + ": " + result.body });
      }
      const parsed = JSON.parse(result.body);
      if (order_nsu) infinitePayStore[order_nsu] = { handle, createdAt: Date.now() };
      json(res, 200, { success: true, url: parsed.url || "", order_nsu: payload.order_nsu });
    } catch (e) { lastDebug.errors.push({ ts: new Date().toISOString(), msg: e.message }); json(res, 500, { error: e.message }); }

  } else if (req.method === "POST" && req.url === "/infinitepay-webhook") {
    try {
      const d = await parseBody(req);
      lastDebug.requests.push({ ts: new Date().toISOString(), endpoint: "infinitepay-webhook", body: JSON.stringify(d).substring(0, 2000) });
      const { order_nsu, transaction_nsu, invoice_slug, paid, capture_method, amount, paid_amount, receipt_url } = d;
      if (order_nsu) {
        infinitePayStore[order_nsu] = {
          ...infinitePayStore[order_nsu],
          transaction_nsu: transaction_nsu || "",
          slug: invoice_slug || "",
          paid: paid || false,
          capture_method: capture_method || "",
          amount: amount || 0,
          paid_amount: paid_amount || 0,
          receipt_url: receipt_url || "",
          webhookReceivedAt: Date.now()
        };
      }
      json(res, 200, { ok: true });
    } catch (e) { json(res, 200, { ok: true }); }

  } else if (req.method === "POST" && req.url === "/infinitepay-check") {
    try {
      const d = await parseBody(req);
      const { handle, order_nsu } = d;
      if (!handle || !order_nsu) return json(res, 400, { error: "handle e order_nsu obrigatorios" });
      const stored = infinitePayStore[order_nsu];
      if (stored && stored.paid) {
        return json(res, 200, { success: true, paid: true, amount: stored.amount, paid_amount: stored.paid_amount, capture_method: stored.capture_method, receipt_url: stored.receipt_url });
      }
      if (stored && stored.transaction_nsu && stored.slug) {
        const payload = { handle, order_nsu, transaction_nsu: stored.transaction_nsu, slug: stored.slug };
        const bodyStr = JSON.stringify(payload);
        const opts = {
          hostname: "api.checkout.infinitepay.io",
          port: 443,
          path: "/payment_check",
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) }
        };
        const result = await new Promise((resolve, reject) => {
          const r = https.request(opts, (res2) => {
            let data = "";
            res2.on("data", (c) => data += c);
            res2.on("end", () => resolve({ status: res2.statusCode, body: data }));
          });
          r.on("error", reject);
          r.setTimeout(30000, () => { r.destroy(); reject(new Error("Timeout")); });
          r.write(bodyStr);
          r.end();
        });
        lastDebug.requests.push({ ts: new Date().toISOString(), endpoint: "infinitepay-check", status: result.status, body: result.body.substring(0, 1000) });
        if (result.status >= 200 && result.status < 300) {
          const parsed = JSON.parse(result.body);
          if (parsed.paid) {
            infinitePayStore[order_nsu].paid = true;
            infinitePayStore[order_nsu].amount = parsed.amount;
            infinitePayStore[order_nsu].paid_amount = parsed.paid_amount;
            infinitePayStore[order_nsu].capture_method = parsed.capture_method;
          }
          return json(res, 200, { success: true, paid: parsed.paid || false, amount: parsed.amount || 0, capture_method: parsed.capture_method || "" });
        }
        return json(res, 200, { success: true, paid: false });
      }
      json(res, 200, { success: true, paid: false, pending_webhook: true });
    } catch (e) { lastDebug.errors.push({ ts: new Date().toISOString(), msg: e.message }); json(res, 500, { error: e.message }); }

  } else {
    json(res, 404, { error: "Not found" });
  }
});
server.listen(PORT, () => { console.log("C6 proxy on port " + PORT); });
setInterval(() => { https.get("https://c6-boleto-proxy.onrender.com/health", () => {}).on("error", () => {}); }, 14 * 60 * 1000);
