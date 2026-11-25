/*
 * Sellsy-Odys MCP — serveur Express pour Railway.
 * Logique Sellsy reprise du connecteur d'Odys (outils/connecteur-sellsy.js) : mêmes outils, même format
 * de réponse (structuredContent avec id, number, ht, ttc, pdf…) que celui attendu par Odys.
 *
 * Variables Railway : SELLSY_ID, SELLSY_SECRET, ODYS_KEY (longue et aléatoire), PORT (fourni par Railway).
 * Adresse du connecteur : https://<domaine>/mcp/<ODYS_KEY>
 */
import express from 'express';
import nodemailer from 'nodemailer';

/*
 * Connecteur Sellsy d'Odys (ENERGETIK FRANCE) — Cloudflare Worker, serveur MCP (HTTP « streamable », réponses JSON).
 * Crée immédiatement un devis dans Sellsy à partir d'une demande d'Odys.
 *
 * Variables secrètes du Worker (Settings → Variables and Secrets, type « Secret ») :
 *   SELLSY_ID      identifiant client de l'accès API Sellsy
 *   SELLSY_SECRET  secret de l'accès API Sellsy
 *   ODYS_KEY       clé d'accès longue et aléatoire : l'adresse du connecteur est https://<worker>/mcp/<ODYS_KEY>
 */
const API = 'https://api.sellsy.com/v2';
const VERSION = '2.14.4';
const PROTO = '2025-06-18';

const TOOLS = [{
  name: 'create_estimate',
  title: 'Créer un devis Sellsy',
  description: "Crée un devis dans Sellsy pour un dossier Odys : retrouve ou crée la fiche client, ajoute les lignes (articles du catalogue Sellsy ou lignes libres, titres de lots) et renvoie le numéro, les montants et les liens PDF du devis.",
  inputSchema: {
    type: 'object',
    properties: {
      job: {
        type: 'object',
        description: "Demande de devis Odys : client {sellsyId, sellsyType, forceNew, societe, civilite, nom, prenom, email, tel, adresse, cp, ville}, rows [{sellsyId, ref, nom, qte, pu, tva, fiche_technique} ou {type:'title', text}], date, subject, note, tvaDefaut, send_email (envoie le devis et les fiches techniques au client par e-mail).",
      },
    },
    required: ['job'],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, {
  name: 'send_estimate',
  title: 'Envoyer un devis Sellsy par e-mail',
  description: "Envoie au client un e-mail avec le lien du devis Sellsy et les liens des fiches techniques des articles.",
  inputSchema: {
    type: 'object',
    properties: {
      estimate_id: { type: 'number', description: 'ID Sellsy du devis' },
      client_email: { type: 'string' },
      client_name: { type: 'string' },
      items: { type: 'array', description: 'Lignes [{nom, qte, pu, fiche_technique}]', items: { type: 'object' } },
      attachments: { type: 'array', description: 'Pièces jointes [{name, content (base64)}] : PDF ou images, 10 Mo au total', items: { type: 'object' } },
      attachment_ids: { type: 'array', description: 'Identifiants de pièces jointes déposées par stage_attachment', items: { type: 'string' } },
      attachment_urls: { type: 'array', description: 'Fiches techniques à joindre depuis le site du fabricant [{name, url}] (PDF)', items: { type: 'object' } },
      mark_sent: { type: 'boolean', description: "Passer le devis brouillon au statut « Envoyé » après l'envoi (défaut : oui ; non pour un envoi de test)" },
      attach_pdf: { type: 'boolean', description: 'Joindre le PDF du devis (défaut : oui)' },
      stage_chunk: { type: 'object', description: "Dépôt d'un morceau de pièce jointe {upload_id, name, index, total, chunk} : n'envoie rien" },
      to_emails: { type: 'array', description: 'Autres destinataires (en plus de client_email)', items: { type: 'string' } },
      bcc_emails: { type: 'array', description: 'Destinataires en copie cachée', items: { type: 'string' } },
      subject: { type: 'string', description: "Objet de l'e-mail (sinon objet par défaut)" },
      message: { type: 'string', description: "Texte de l'e-mail rédigé (texte brut, paragraphes séparés par une ligne vide). Le bouton vers le devis est ajouté sous le texte." },
      include_items: { type: 'boolean', description: 'Ajouter le tableau des articles (défaut : oui si pas de message rédigé)' },
    },
    required: ['estimate_id', 'client_email'],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, {
  name: 'stage_attachment',
  title: "Déposer une pièce jointe (par morceaux) avant l'envoi d'un devis",
  description: "Dépose un morceau (base64, 300 Ko max) d'une pièce jointe. Envoyer les morceaux dans l'ordre (index 0..total-1) avec le même upload_id, puis passer upload_id dans attachment_ids de send_estimate. Conservé 1 heure.",
  inputSchema: {
    type: 'object',
    properties: {
      upload_id: { type: 'string' }, name: { type: 'string' },
      index: { type: 'number' }, total: { type: 'number' }, chunk: { type: 'string' },
    },
    required: ['upload_id', 'name', 'index', 'total', 'chunk'],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, {
  name: 'send_relance',
  title: 'Relancer le client sur son devis',
  description: "Envoie au client l'e-mail de relance du devis (7 jours après l'envoi). Ne fait rien si le devis est déjà accepté, refusé, annulé ou facturé dans Sellsy.",
  inputSchema: {
    type: 'object',
    properties: {
      estimate_id: { type: 'number', description: 'ID Sellsy du devis' },
      client_email: { type: 'string' },
      client_name: { type: 'string', description: 'Civilité et nom, ex. « M. Dupont »' },
      bcc_emails: { type: 'array', description: 'Destinataires en copie cachée', items: { type: 'string' } },
    },
    required: ['estimate_id', 'client_email'],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, {
  name: 'catalog_api',
  title: 'Gérer le catalogue Sellsy',
  description: "Lit ou modifie le catalogue Sellsy (articles, taxes, unités) : appel direct de l'API Sellsy V2 : catalogue (/items, /taxes, /units) en lecture et écriture, clients et devis en lecture seule ; remises TTC (CEE, MaPrimeRénov') liables et déliables sur un devis.",
  inputSchema: {
    type: 'object',
    properties: {
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      path: { type: 'string', description: 'Chemin API V2, ex. /items?limit=100 ou /items/123' },
      body: { type: 'object' },
    },
    required: ['method', 'path'],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, {
  name: 'ping',
  title: 'Tester la connexion Sellsy',
  description: "Vérifie que le connecteur joint Sellsy avec ses identifiants. Ne modifie rien.",
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true, openWorldHint: true },
}];

/* ---------- utilitaires ---------- */
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function phone(s) {
  let d = String(s || '').replace(/\D/g, '');
  if (d.startsWith('0') && d.length === 10) d = '33' + d.slice(1);
  return d ? '+' + d : null;
}
const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ''));

class Sellsy {
  constructor(env) { this.env = env; this.token = null; this.taxes = null; }
  async auth() {
    if (this.token) return;
    const r = await fetch('https://login.sellsy.com/oauth2/access-tokens', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: this.env.SELLSY_ID || '', client_secret: this.env.SELLSY_SECRET || '' }),
    });
    if (!r.ok) throw new Error('Identifiants Sellsy refusés (' + r.status + ') : ' + (await r.text()).slice(0, 300));
    this.token = (await r.json()).access_token;
  }
  async call(method, path, body) {
    await this.auth();
    for (let k = 0; k < 3; k++) {
      const r = await fetch(API + path, {
        method, headers: { Authorization: 'Bearer ' + this.token, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (r.status === 429 && k < 2) { await new Promise(res => setTimeout(res, 2000)); continue; }
      const txt = await r.text();
      if (!r.ok) throw new Error(method + ' ' + path + ' → ' + r.status + ' ' + txt.slice(0, 600));
      return txt ? JSON.parse(txt) : {};
    }
  }
  async taxId(rate, def) {
    if (!this.taxes) {
      this.taxes = {};
      for (const t of (await this.call('GET', '/taxes?limit=100')).data || []) {
        if (t.is_active) { const k = Number(t.rate).toFixed(1); if (!(k in this.taxes)) this.taxes[k] = t.id; }
      }
    }
    const key = v => { const x = parseFloat(String(v ?? '').replace(',', '.').replace('%', '')); return isNaN(x) ? null : x.toFixed(1); };
    const d = key(def) || '5.5';
    return this.taxes[key(rate) || d] || this.taxes[d];
  }
  async search(q, type) {
    const r = await this.call('GET', '/search?' + new URLSearchParams({ q, limit: '20' }) + '&type%5B%5D=' + type);
    return r.data || [];
  }
  async address(kind, id, c) {
    if (!c.adresse && !c.ville) return;
    await this.call('POST', `/${kind}/${id}/addresses`, {
      name: 'Adresse principale', address_line_1: c.adresse || '-', postal_code: c.cp || '', city: c.ville || '',
      country_code: 'FR', is_invoicing_address: true, is_delivery_address: true,
    });
  }
  /* retourne [id, type, créé ?] */
  async client(c) {
    if (c.sellsyId) return [Number(c.sellsyId), c.sellsyType || 'individual', false];
    if (c.societe) {
      if (!c.forceNew) {
        const k = norm(c.societe);
        for (const h of await this.search(c.societe, 'company')) {
          const o = h.object || {};
          if (o.type === 'company' && norm(h.name || h.company_name) === k) return [o.id, 'company', false];
        }
      }
      const co = await this.call('POST', '/companies', clean({ type: 'prospect', name: c.societe, email: c.email, phone_number: phone(c.tel) }));
      await this.address('companies', co.id, c);
      return [co.id, 'company', true];
    }
    if (!c.forceNew) {
      if (c.email) {
        const r = await this.call('POST', '/individuals/search?limit=5', { filters: { email: c.email } });
        if (r.data && r.data.length) return [r.data[0].id, 'individual', false];
      }
      if (c.nom) {
        const mob = phone(c.tel);
        for (const h of await this.search(c.nom, 'individual')) {
          const o = h.object || {};
          const sameName = norm(h.last_name) === norm(c.nom) && (!c.prenom || norm(h.first_name) === norm(c.prenom));
          const sameTel = mob && phone(h.mobile_number || h.phone_number) === mob;
          if (o.type === 'individual' && sameName && (sameTel || !mob)) return [o.id, 'individual', false];
        }
      }
    }
    const ind = await this.call('POST', '/individuals', clean({
      type: 'prospect', last_name: c.nom || 'Client', first_name: c.prenom,
      civility: String(c.civilite || '').startsWith('Mme') ? 'mrs' : 'mr', email: c.email, mobile_number: phone(c.tel),
    }));
    await this.address('individuals', ind.id, c);
    return [ind.id, 'individual', true];
  }
}

/* ---------- e-mail (fiches techniques) ---------- */
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = u => /^https?:\/\//i.test(String(u || '')) ? String(u) : null;
let mailer = null;
function getMailer(env) {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS)
    throw new Error("Envoi d'e-mail non configuré : ajoutez BREVO_API_KEY (ou SMTP_HOST, SMTP_USER, SMTP_PASS) dans les variables Railway");
  if (!mailer) {
    const port = Number(env.SMTP_PORT || 465);
    mailer = nodemailer.createTransport({ host: env.SMTP_HOST, port, secure: port === 465, auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000 });
  }
  return mailer;
}
const STAGE = new Map(); // upload_id -> { name, total, parts[], at }
function stagePut(a) {
  const id = String(a.upload_id || ''); if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) throw new Error('upload_id invalide');
  const total = Number(a.total), index = Number(a.index), chunk = String(a.chunk || '').replace(/\s+/g, '');
  if (!(total >= 1 && total <= 60) || !(index >= 0 && index < total)) throw new Error('Découpage invalide');
  if (!/^[A-Za-z0-9+/=]*$/.test(chunk) || chunk.length > 420000) throw new Error('Morceau invalide');
  const now = Date.now(); for (const [k, v] of STAGE) if (now - v.at > 3600e3) STAGE.delete(k);
  if (STAGE.size > 200) throw new Error('Trop de pièces jointes en attente');
  let e = STAGE.get(id); if (!e || e.total !== total) { e = { name: String(a.name || 'document.pdf'), total, parts: new Array(total).fill(null), at: now }; STAGE.set(id, e); }
  e.parts[index] = chunk; e.at = now;
  const size = e.parts.reduce((t, p) => t + (p ? p.length : 0), 0); if (size * 0.75 > 10 * 1048576) { STAGE.delete(id); throw new Error('Pièce jointe trop lourde (10 Mo maximum)'); }
  return { received: e.parts.filter(Boolean).length, total };
}
function stageGet(ids) {
  return (Array.isArray(ids) ? ids : []).slice(0, 10).map(id => {
    const e = STAGE.get(String(id)); if (!e) throw new Error('Pièce jointe introuvable ou expirée : ' + id);
    if (e.parts.some(p => p === null)) throw new Error('Pièce jointe incomplète : ' + e.name);
    return { name: e.name, content: e.parts.join('') };
  });
}
async function fetchUrlAttachments(list) {
  const out = [], skipped = [];
  for (const x of (Array.isArray(list) ? list : []).slice(0, 8)) {
    const url = safeUrl(x && x.url), name0 = String((x && x.name) || 'Fiche technique').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 110);
    if (!url) { skipped.push(name0 + ' (lien invalide)'); continue; }
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 25000);
    try {
      const r = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36', Accept: 'application/pdf,*/*' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.slice(0, 4).toString() !== '%PDF') throw new Error('pas un PDF');
      if (buf.length > 8 * 1048576) throw new Error('fichier de ' + (buf.length / 1048576).toFixed(1) + ' Mo, trop lourd');
      out.push({ name: /\.pdf$/i.test(name0) ? name0 : name0 + '.pdf', content: buf.toString('base64') });
    } catch (e) { skipped.push(name0 + ' (' + String(e && e.name === 'AbortError' ? 'délai dépassé' : (e && e.message) || e).slice(0, 60) + ')'); }
    finally { clearTimeout(tm); }
  }
  return { out, skipped };
}
/* Signature des e-mails clients (modèle C) — logo servi par ce serveur */
const PUBLIC_URL = String(process.env.PUBLIC_URL || 'https://sellsy-odys-mcp-production.up.railway.app').replace(/\/$/, '');
function signatureHtml(nom, tel) {
  nom = nom || 'Yassine Erras'; tel = tel || '06 98 19 07 24';
  const seg = c => `<td height="3" bgcolor="${c}" style="font-size:0;line-height:0;height:3px">&nbsp;</td>`;
  const F = 'font-family:Arial,Helvetica,sans-serif;';
  return `<table cellpadding="0" cellspacing="0" border="0" role="presentation" width="520" style="${F}margin-top:6px;border-collapse:collapse;max-width:520px">` +
    `<tr><td colspan="2" style="padding-bottom:14px"><table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%"><tr>${seg('#8E3D86')}${seg('#C2652F')}${seg('#3E8C86')}</tr></table></td></tr>` +
    `<tr><td width="150" valign="middle" style="padding-right:12px"><img src="${PUBLIC_URL}/logo-energetik.png" width="135" height="71" alt="ENERGETIK FRANCE" style="display:block;border:0;outline:none;text-decoration:none"></td>` +
    `<td valign="middle" style="${F}font-size:13px;line-height:20px;color:#555555">` +
    `<div style="font-size:16px;line-height:22px;font-weight:bold;color:#2b2b2b">${esc(nom)}</div>` +
    `<div>Mobile ${esc(tel)} · Agence 02 40 45 79 33</div>` +
    `<div>13 rue de la Dutée, 44800 Saint-Herblain</div>` +
    `<div><a href="https://www.energetikfrance.fr/" style="color:#3E8C86;text-decoration:none;font-weight:bold">www.energetikfrance.fr</a></div></td></tr>` +
    `<tr><td colspan="2" style="padding-top:14px"><table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%" style="border-top:1px solid #e6e6e6"><tr>` +
    `<td valign="middle" style="${F}font-size:12px;line-height:17px;color:#888888;padding-top:10px">Entreprise certifiée RGE<br>Pompes à chaleur · isolation · ventilation</td>` +
    `<td valign="middle" align="right" style="padding-top:10px;white-space:nowrap"><img src="${PUBLIC_URL}/cert/qualipac.png" width="97" height="40" alt="RGE QualiPAC 2026" style="width:97px;height:40px;border:0;vertical-align:middle">&nbsp;&nbsp;<img src="${PUBLIC_URL}/cert/ventilation.png" width="97" height="40" alt="RGE Ventilation+ 2026" style="width:97px;height:40px;border:0;vertical-align:middle">&nbsp;&nbsp;<img src="${PUBLIC_URL}/cert/ppe.png" width="30" height="56" alt="RGE Les Pros de la performance énergétique" style="width:30px;height:56px;border:0;vertical-align:middle">&nbsp;&nbsp;<img src="${PUBLIC_URL}/cert/qualibat.png" height="48" alt="RGE Qualibat" style="height:48px;width:auto;border:0;vertical-align:middle"></td>` +
    `</tr></table></td></tr></table>`;
}
function cleanAttachments(a) {
  if (!Array.isArray(a) || !a.length) return [];
  let tot = 0;
  const out = a.slice(0, 10).map(x => {
    const name = String((x && x.name) || 'document.pdf').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 120);
    const content = String((x && x.content) || '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
    if (!/\.(pdf|png|jpe?g)$/i.test(name)) throw new Error('Pièce jointe refusée (PDF ou image uniquement) : ' + name);
    if (!content || !/^[A-Za-z0-9+/=]+$/.test(content)) throw new Error('Pièce jointe illisible : ' + name);
    tot += content.length * 0.75; return { name, content };
  });
  if (tot > 15 * 1024 * 1024) throw new Error('Pièces jointes trop lourdes (' + (tot / 1048576).toFixed(1) + ' Mo, 15 Mo maximum)');
  return out;
}
const EMAIL_RE = /^[^@\s<>"',;]+@[^@\s<>"',;]+\.[^@\s<>"',;]+$/;
function emailList(v, label) {
  const a = (Array.isArray(v) ? v : String(v || '').split(/[,;\s]+/)).map(x => String(x || '').trim()).filter(Boolean);
  a.forEach(x => { if (!EMAIL_RE.test(x)) throw new Error('Adresse e-mail invalide (' + label + ') : ' + x); });
  if (a.length > 10) throw new Error('10 adresses maximum (' + label + ')');
  return [...new Set(a.map(x => x.toLowerCase()))];
}
async function sendEstimateEmail(env, { to, name, est, items, attachments, subject: subj, message, includeItems, toMore, bcc }) {
  if (!to) throw new Error('Adresse e-mail du client absente');
  const lines = (items || []).filter(r => r && r.type !== 'title').map(r => {
    const fiche = safeUrl(r.fiche_technique || r.datasheet_url);
    return `<tr><td>${esc(r.nom || r.description || 'Article')}</td><td style="text-align:center">${esc(r.qte ?? r.quantity ?? 1)}</td>` +
      `<td>${fiche ? `<a href="${esc(fiche)}">Fiche technique</a>` : '—'}</td></tr>`;
  }).join('');
  const lien = safeUrl(est.public) || safeUrl(est.pdf);
  const table = lines ? `<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse"><tr style="background:#f2f2f2"><th>Article</th><th>Qté</th><th>Fiche technique</th></tr>${lines}</table>` : '';
  const custom = String(message || '').trim();
  const html = custom ? custom.split(/\n\s*\n/).map(p => '<p>' + esc(p.trim()).replace(/\n/g, '<br>') + '</p>').join('\n') +
    (lien ? `\n<p>👉 <a href="${esc(lien)}"><b>Consulter et signer mon devis en ligne</b></a></p>` : '') + (includeItems ? '\n' + table : '')
  : `<p>Bonjour${name ? ' ' + esc(name) : ''},</p>
<p>Veuillez trouver ci-joint votre devis <b>${esc(est.number || est.id)}</b>${est.subject ? ' (' + esc(est.subject) + ')' : ''}${lien ? ` (également consultable en ligne : <a href="${esc(lien)}">consulter le devis</a>)` : ''}.</p>
${(attachments || []).length ? `<p>Vous trouverez en pièces jointes : ${(attachments || []).map(x => esc(x.name.replace(/\.[a-z]+$/i, ''))).join(', ')}.</p>` : ''}
${lines ? `<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse"><tr style="background:#f2f2f2"><th>Article</th><th>Qté</th><th>Fiche technique</th></tr>${lines}</table>` : ''}
<p>Cordialement,<br><b>ENERGETIK FRANCE</b><br>02 40 45 79 33 · <a href="mailto:contact@energetikfrance.fr">contact@energetikfrance.fr</a></p>`;
  const subject = String(subj || '').trim().slice(0, 200) || ('Votre devis ENERGETIK FRANCE ' + (est.number || ''));
  const from = env.FROM_EMAIL || env.SMTP_USER || 'contact@energetikfrance.fr';
  if (env.BREVO_API_KEY) {
    // Envoi par l'API HTTPS de Brevo (le SMTP est bloqué sur les offres Railway hors Pro)
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST', signal: ctl.signal,
        headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(Object.assign({ sender: { name: env.FROM_NAME || 'ENERGETIK FRANCE', email: from }, replyTo: { email: from, name: 'ENERGETIK FRANCE' }, to: [{ email: to, name: name || undefined }, ...(toMore || []).filter(x => x !== String(to).toLowerCase()).map(email => ({ email }))], subject, htmlContent: html }, (bcc || []).length ? { bcc: bcc.map(email => ({ email })) } : {}, (attachments || []).length ? { attachment: attachments } : {})),
      });
      const txt = await r.text();
      if (!r.ok) throw new Error('Brevo ' + r.status + ' : ' + txt.slice(0, 300));
      return (JSON.parse(txt || '{}').messageId) || 'brevo';
    } finally { clearTimeout(t); }
  }
  const info = await getMailer(env).sendMail({ from, to: [to, ...(toMore || [])].join(', '), bcc: (bcc || []).join(', ') || undefined, subject, html, attachments: (attachments || []).map(x => ({ filename: x.name, content: Buffer.from(x.content, 'base64') })) });
  return info.messageId;
}


const FINAL_STATUS = ['accepted', 'refused', 'cancelled', 'advanced', 'invoiced', 'partialinvoiced'];
const eurFr = v => Number(v || 0).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
async function sendRelanceEmail(env, { to, name, est, bcc }) {
  if (!to) throw new Error('Adresse e-mail du client absente');
  const expired = est.status === 'expired';
  const lien = expired ? null : safeUrl(est.public);
  const d = est.date ? new Date(est.date + 'T12:00:00') : null, jours = d ? Math.round((Date.now() - d) / 864e5) : 7;
  const quand = !d || jours <= 10 ? 'Il y a une semaine' : 'Le ' + d.getDate() + (d.getDate() === 1 ? 'er' : '') + ' ' + MOIS[d.getMonth()] + (d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : '');
  // PDF du devis joint (le lien de téléchargement Sellsy expire au bout de quelques minutes)
  let attachment = [];
  if (est.pdf) {
    try {
      const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 20000);
      const r = await fetch(est.pdf, { signal: ctl.signal }); clearTimeout(tm);
      const buf = Buffer.from(await r.arrayBuffer());
      if (r.ok && buf.slice(0, 4).toString() === '%PDF') attachment = [{ name: 'Devis ' + String(est.number).replace(/[\\/:*?"<>|]+/g, '_') + '.pdf', content: buf.toString('base64') }];
    } catch (e) { /* relance envoyée sans pièce jointe */ }
  }
  const html = `<p>Bonjour${name ? ' ' + esc(name) : ''},</p>
<p>${esc(quand)}, nous vous avons transmis notre devis n° <b>${esc(est.number)}</b> d'un montant de <b>${esc(eurFr(est.ttc))} TTC</b>${attachment.length ? ' (vous le retrouverez en pièce jointe)' : ''}.</p>
<p>Avez-vous pu en prendre connaissance ? Nous restons à votre disposition pour répondre à vos questions ou ajuster la proposition si besoin.</p>
${expired ? '<p>La durée de validité de ce devis étant dépassée, nous pouvons vous en adresser une version actualisée sur simple demande.</p>' : ''}
<p>N'hésitez pas à revenir vers nous pour nous tenir informés de l'avancement de votre projet, même si votre décision n'est pas encore prise.</p>
${lien ? `<p>👉 <a href="${esc(lien)}"><b>Consulter et signer mon devis en ligne</b></a></p>` : ''}
<p>Vous pouvez simplement répondre à cet e-mail ou nous appeler au <b>02 40 45 79 33</b>.</p>
<p>Cordialement,<br><b>L'équipe ENERGETIK FRANCE</b><br>13 rue de la Dutée — 44800 Saint-Herblain<br>02 40 45 79 33 · <a href="mailto:contact@energetikfrance.fr">contact@energetikfrance.fr</a></p>`;
  return sendMail(env, { to, name, subject: 'Votre devis ENERGETIK FRANCE n° ' + est.number, html, attachment, bcc });
}
async function sendMail(env, { to, name, subject, html, attachment, bcc }) {
  const from = env.FROM_EMAIL || env.SMTP_USER || 'contact@energetikfrance.fr';
  if (env.BREVO_API_KEY) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST', signal: ctl.signal,
        headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(Object.assign({ sender: { name: env.FROM_NAME || 'ENERGETIK FRANCE', email: from }, replyTo: { email: from, name: 'ENERGETIK FRANCE' }, to: [{ email: to, name: name || undefined }], subject, htmlContent: html }, (attachment || []).length ? { attachment } : {}, (bcc || []).length ? { bcc: bcc.map(email => ({ email })) } : {})),
      });
      const txt = await r.text();
      if (!r.ok) throw new Error('Brevo ' + r.status + ' : ' + txt.slice(0, 300));
      return (JSON.parse(txt || '{}').messageId) || 'brevo';
    } finally { clearTimeout(t); }
  }
  const info = await getMailer(env).sendMail({ from, to, subject, html });
  return info.messageId;
}

function summary(e) {
  const a = e.amounts || {}, rel = (e.related || [])[0] || {}, pl = e.public_link;
  return {
    id: e.id, number: e.number, status: e.status, date: e.date,
    ht: Number(a.total_excl_tax || 0), ttc: Number(a.total || a.total_incl_tax || 0), name: e.company_name || '',
    relType: rel.type, relId: rel.id, pdf: e.pdf_link || null,
    public: pl && typeof pl === 'object' ? (pl.enabled ? pl.url : null) : (pl || null), subject: e.subject || '',
  };
}


/* Complète le descriptif d'un article (superficie, chaudière remplacée, n° EPREL) */
const DOTS = '(?:\\.|…|&hellip;|&nbsp;|\\u00a0| )*(?:\\.|…|&hellip;){3,}(?:\\.|…|&hellip;|&nbsp;|\\u00a0)*';
function fillDesc(html, f) {
  let d = String(html || '');
  const txt = v => esc(String(v).trim());
  if (f.superficie) d = d.replace(new RegExp('(Superficie de la maison\\s*:\\s*(?:</strong>)?\\s*)' + DOTS, 'i'), '$1' + txt(f.superficie).replace(/\s*m(²|2)?$/i, '') + ' m²');
  if (f.chaudiere) d = d.replace(new RegExp("(en remplacement d['’]une chaudi(?:è|&egrave;)re\\s*)" + DOTS, 'i'), '$1' + txt(f.chaudiere));
  if (f.eprel && !/EPREL/i.test(d)) {
    const line = "<strong>N° d'enregistrement EPREL : </strong>" + txt(f.eprel) + '<br />';
    const m = d.match(/<strong>\s*R(?:é|&eacute;)f(?:é|&eacute;)rence\s*:\s*<\/strong>[^<]*<br\s*\/?>/i);
    d = m ? d.replace(m[0], m[0] + line) : d + (d ? '<br />' : '') + line;
  }
  if (f.repere) d = '<strong>Repère : </strong>' + txt(f.repere) + '<br />' + d.replace(/^<strong>Rep(?:è|&egrave;)re : <\/strong>[^<]*<br \/>/i, '');
  return d;
}

async function createEstimate(env, job) {
  if (!job || typeof job !== 'object') throw new Error('Demande de devis absente');
  const rows0 = Array.isArray(job.rows) ? job.rows : [];
  if (!rows0.some(r => r && r.type !== 'title')) throw new Error('Aucune ligne de devis');
  const sy = new Sellsy(env);
  const [cid, ctype, created] = await sy.client(job.client || {});
  const rows = [];
  for (const r of rows0) {
    if (r.type === 'title') { rows.push({ type: 'title', text: r.text || '' }); continue; }
    const row = { quantity: String(r.qte || 1), unit_amount: Number(r.pu || 0).toFixed(2), tax_id: await sy.taxId(r.tva, job.tvaDefaut || '5.5') };
    if (r.sellsyId) {
      Object.assign(row, { type: 'catalog', related: { type: 'product', id: Number(r.sellsyId) } });
      if (r.fill && typeof r.fill === 'object') {
        try {
          const it = await sy.call('GET', '/items/' + Number(r.sellsyId));
          const d = fillDesc(it.description || '', r.fill);
          if (d && d !== it.description) Object.assign(row, { reference: it.reference || undefined, description: d });
        } catch (e) { /* description du catalogue conservée */ }
      }
    }
    else Object.assign(row, clean({ type: 'single', reference: String(r.ref || '').slice(0, 100), description: r.nom || '' }));
    rows.push(row);
  }
  const body = {
    date: job.date || new Date().toISOString().slice(0, 10), subject: job.subject || '', note: job.note || '',
    currency: 'EUR', related: [{ type: ctype, id: cid }], rows,
  };
  const e0 = await sy.call('POST', '/estimates', body);
  const e = await sy.call('GET', '/estimates/' + e0.id);
  return Object.assign(summary(e), { clientId: cid, clientType: ctype, clientCree: created });
}

/* ---------- MCP (JSON-RPC 2.0 sur HTTP) ---------- */
const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(env, m) {
  if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return err(m && m.id !== undefined ? m.id : null, -32600, 'Requête invalide');
  const isNotif = m.id === undefined || m.id === null;
  switch (m.method) {
    case 'initialize':
      return ok(m.id, {
        protocolVersion: (m.params && m.params.protocolVersion) || PROTO,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'sellsy-odys', title: 'Sellsy Odys', version: VERSION },
        instructions: "Connecteur Sellsy d'Odys (ENERGETIK FRANCE) : création immédiate des devis.",
      });
    case 'ping': return isNotif ? null : ok(m.id, {});
    case 'tools/list': return ok(m.id, { tools: TOOLS });
    case 'tools/call': {
      const name = m.params && m.params.name, args = (m.params && m.params.arguments) || {};
      try {
        if (name === 'create_estimate') {
          const s = await createEstimate(env, args.job);
          if (args.job && args.job.send_email) {
            try {
              const c = args.job.client || {};
              await sendEstimateEmail(env, { to: c.email, name: [c.prenom, c.nom].filter(Boolean).join(' ') || c.societe, est: s, items: args.job.rows });
              s.emailEnvoye = true;
            } catch (e) { s.emailEnvoye = false; s.emailErreur = String(e && e.message || e).slice(0, 300); }
          }
          return ok(m.id, { content: [{ type: 'text', text: 'Devis ' + s.number + ' créé dans Sellsy : ' + s.ttc.toFixed(2) + ' € TTC' }], structuredContent: s, isError: false });
        }
        if (name === 'send_estimate' && args.stage_chunk && typeof args.stage_chunk === 'object') {
          // dépôt d'un morceau de pièce jointe via l'outil existant (les clients qui n'ont pas encore l'outil stage_attachment)
          const r = stagePut(args.stage_chunk);
          return ok(m.id, { content: [{ type: 'text', text: 'Morceau ' + (Number(args.stage_chunk.index) + 1) + '/' + r.total + ' reçu (rien n\'a été envoyé)' }], structuredContent: Object.assign({ staged: true }, r), isError: false });
        }
        if (name === 'send_estimate') {
          const sy = new Sellsy(env), eid = Number(args.estimate_id);
          const fu = await fetchUrlAttachments(args.attachment_urls);
          let att = cleanAttachments([...(args.attachments || []), ...stageGet(args.attachment_ids), ...fu.out]);
          const toMore = emailList(args.to_emails, 'destinataires'), bcc = emailList(args.bcc_emails, 'copie cachée');
          emailList([args.client_email], 'client');
          let est = summary(await sy.call('GET', '/estimates/' + eid));
          const wasDraft = est.status === 'draft';
          // PDF du devis joint à l'e-mail (le lien de téléchargement Sellsy expire au bout de quelques minutes)
          if (args.attach_pdf !== false && est.pdf) {
            const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 20000);
            try {
              const r = await fetch(est.pdf, { signal: ctl.signal });
              if (!r.ok) throw new Error('HTTP ' + r.status);
              const buf = Buffer.from(await r.arrayBuffer());
              if (buf.length < 100 || buf.slice(0, 4).toString() !== '%PDF') throw new Error('fichier reçu non PDF');
              att.unshift({ name: 'Devis ' + String(est.number || eid).replace(/[\\/:*?"<>|]+/g, '_') + '.pdf', content: buf.toString('base64') });
            } catch (e) { throw new Error('PDF du devis ' + est.number + ' introuvable dans Sellsy (' + String(e && e.message || e).slice(0, 120) + ') : rien n\'a été envoyé'); }
            finally { clearTimeout(tm); }
          }
          est.pdf = null; // jamais de lien de téléchargement temporaire dans l'e-mail
          if (wasDraft && args.mark_sent === false) est.public = null; // envoi de test : le lien client ne s'ouvre pas tant que le devis est brouillon
          const id = await sendEstimateEmail(env, { to: args.client_email, name: args.client_name, est, items: args.items, attachments: att, toMore, bcc, subject: args.subject, message: args.message, includeItems: args.include_items === undefined ? !args.message : !!args.include_items });
          (args.attachment_ids || []).forEach(k => STAGE.delete(String(k)));
          // Une fois l'e-mail parti, le devis brouillon passe au statut « Envoyé » dans Sellsy (sauf envoi de test)
          let statut = est.status, statutErreur = '';
          if (wasDraft && args.mark_sent !== false) {
            try { await sy.call('PUT', '/estimates/' + eid + '/status', { status: 'sent' }); statut = 'sent'; }
            catch (e) { statutErreur = String(e && e.message || e).slice(0, 200); }
          }
          return ok(m.id, { content: [{ type: 'text', text: 'Devis ' + est.number + ' envoyé à ' + [args.client_email, ...toMore].join(', ') + (bcc.length ? ' (Cci : ' + bcc.join(', ') + ')' : '') }], structuredContent: { ok: true, number: est.number, messageId: id, to: [args.client_email, ...toMore], bcc, status: statut, statusError: statutErreur, attached: att.map(x => x.name), skipped: fu.skipped }, isError: false });
        }
        if (name === 'stage_attachment') {
          const r = stagePut(args);
          return ok(m.id, { content: [{ type: 'text', text: 'Morceau ' + (Number(args.index) + 1) + '/' + r.total + ' reçu' }], structuredContent: r, isError: false });
        }
        if (name === 'send_relance') {
          const est = summary(await new Sellsy(env).call('GET', '/estimates/' + Number(args.estimate_id)));
          if (FINAL_STATUS.includes(est.status) || est.status === 'draft') {
            return ok(m.id, { content: [{ type: 'text', text: 'Pas de relance : devis ' + est.number + ' au statut ' + est.status }], structuredContent: { ok: true, skipped: true, status: est.status, number: est.number }, isError: false });
          }
          const id = await sendRelanceEmail(env, { to: args.client_email, name: args.client_name, est, bcc: emailList(args.bcc_emails, 'copie cachée') });
          return ok(m.id, { content: [{ type: 'text', text: 'Relance du devis ' + est.number + ' envoyée à ' + args.client_email }], structuredContent: { ok: true, skipped: false, status: est.status, number: est.number, messageId: id }, isError: false });
        }
        if (name === 'catalog_api') {
          const meth = String(args.method || 'GET').toUpperCase(), path = String(args.path || '');
          if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(meth)) throw new Error('Méthode non autorisée');
          const readOnly = /^\/(individuals|companies|contacts|estimates|search|staffs|discount-incl-taxes)(\/|\?|$)/.test(path);
          const estEdit = (meth === 'PUT' || meth === 'PATCH') && /^\/estimates\/\d+$/.test(path);
          const estStatus = meth === 'PUT' && /^\/estimates\/\d+\/status$/.test(path);
          /* remises TTC (CEE, MaPrimeRénov') : liaison / déliaison sur un devis */
          const estDisc = ((meth === 'POST' || meth === 'DELETE') && /^\/estimates\/\d+\/discount-incl-taxes\/\d+$/.test(path)) || (meth === 'PUT' && /^\/discount-incl-taxes\/\d+$/.test(path));
          if (meth === 'DELETE' && !estDisc) throw new Error('Suppression non autorisée : ' + path);
          if (path.includes('..') || !(/^\/(items|taxes|units)(\/|\?|$)/.test(path) || estEdit || estStatus || estDisc || (readOnly && meth === 'GET') || (meth === 'POST' && /^\/(individuals|companies|estimates)\/search(\?|$)/.test(path)))) throw new Error('Chemin non autorisé : ' + path);
          if (estEdit) { const cur = await new Sellsy(env).call('GET', path); if (cur.status !== 'draft') throw new Error('Seul un devis en brouillon peut être modifié (statut : ' + cur.status + ')'); }
          const r = await new Sellsy(env).call(meth, path, (meth === 'GET' || meth === 'DELETE') ? undefined : (args.body || {}));
          return ok(m.id, { content: [{ type: 'text', text: JSON.stringify(r).slice(0, 60000) }], structuredContent: r, isError: false });
        }
        if (name === 'ping') {
          const sy = new Sellsy(env); await sy.auth();
          return ok(m.id, { content: [{ type: 'text', text: 'Connexion Sellsy OK' }], structuredContent: { ok: true }, isError: false });
        }
        return err(m.id, -32602, 'Outil inconnu : ' + name);
      } catch (e) {
        return ok(m.id, { content: [{ type: 'text', text: String(e && e.message || e).slice(0, 900) }], isError: true });
      }
    }
    default:
      if (isNotif) return null; // notifications/initialized, notifications/cancelled…
      return err(m.id, -32601, 'Méthode inconnue : ' + m.method);
  }
}

function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/* ---------- Serveur HTTP (Express) ---------- */
const env = process.env;
const PORT = env.PORT || 8080;
const log = (...a) => console.log('[' + new Date().toISOString() + ']', ...a);

const app = express();
app.use(express.json({ limit: '15mb' }));

app.get('/', (req, res) => res.json({ service: 'Sellsy-Odys-MCP', version: VERSION }));
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

const keyOk = req => !!env.ODYS_KEY && safeEq(req.params.key || '', env.ODYS_KEY);

app.all('/mcp/:key', async (req, res) => {
  if (!keyOk(req)) return res.status(404).send('Not found');
  if (req.method !== 'POST') return res.status(405).set('Allow', 'POST').end();
  const body = req.body;
  if (!body || typeof body !== 'object') return res.status(400).json(err(null, -32700, 'JSON invalide'));
  try {
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map(x => handle(env, x)))).filter(Boolean);
      return out.length ? res.json(out) : res.status(202).end();
    }
    const tool = body.method === 'tools/call' ? ' ' + (body.params && body.params.name) : '';
    log('MCP', body.method + tool);
    const r = await handle(env, body);
    if (r && r.result && r.result.isError) log('Erreur outil :', r.result.content[0].text);
    else if (r && r.result && r.result.structuredContent && r.result.structuredContent.number)
      log('Devis créé :', r.result.structuredContent.number, '(id ' + r.result.structuredContent.id + ')');
    return r ? res.json(r) : res.status(202).end();
  } catch (e) {
    log('ERREUR /mcp :', e && e.message);
    return res.status(500).json(err(body.id ?? null, -32603, String(e && e.message || e)));
  }
});

// Logo de la signature des e-mails + aperçu de la signature
const LOGO_PNG = Buffer.from('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', 'base64');
app.get('/logo-energetik.png', (req, res) => { res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800' }); res.send(LOGO_PNG); });
// Logos RGE QualiPAC / Qualibat (repris du site energetikfrance.fr, mis en cache)
const CERT_SRC = { qualipac: 'https://primary.jwwb.nl/public/i/y/l/temp-gugbtgcrsqjihahiidwi/logo-qualipac-2024-rge-01-standard-8kau8u.png', qualibat: 'https://primary.jwwb.nl/public/i/y/l/temp-gugbtgcrsqjihahiidwi/logorge-2.png' };
const CERT_CACHE = {};
// Logos RGE fournis (QualiPAC 2026, Ventilation+ 2026, Les Pros de la performance énergétique)
const CERT_PNG = { qualipac: Buffer.from('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', 'base64'), ventilation: Buffer.from('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', 'base64'), ppe: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAADwAAABwCAMAAAB1uONXAAAAwFBMVEX+0gA1FXX///9yl9rD1n6RtRvJvtg/ZZ6BlYP777D12Eh+XZ+6skyhiLhcN4lGes745X7dwiKatOTY4v5lh6bt89nU4aWhpm+wpsqHo7+lwzS70V3N28bezV2Id65gicbF1er30xxPdq9NIn1mUJfLujiwxePd3dzi68D332Lv7fTpxgl5lJ2rxkyFptz56pn89Md3kLTM3JHFwXqwu82bqLv//Nz92i7FxcaestGlmMJ6mcmrq2BRf8BCdLzk4O2G0tkYAAAGwklEQVR42q2ZC0PaOhTHIYNuipRZBJl4SSbYQpC4y3XTUku+/7fa/yR90Qei3qNISPLreSa0scWOiiQx73WjrTc5tBzJtDwdNhy9tNPvue0dC+p0t+pR+qMZc1x33p7P5zMW6BNhUrjruXPBdm137s7n7QXTwVFYZsLkjPTBWAda526vH7DgCJzGBsZqJhftuQuDe0ySYof6gzqnc836adbrTcjVGYwl6THWA9zHiMOOwM5sYea3Z7gKNRYTmMBY316nXR+xlo0QDCVLXbc9YU8UI5B6MoHTrumvj1gCz+bWUqg0IV6wGSVJk9M0spCyGZ6QBmdGtJ4QrIG48ye2wN/FDiVWF7EEDiglJrhtx6Hkyh6p7BuTZmZOjdOtpKLINk162jsTML2zySKTFjqY9OvsTmHKyeyJNE8YJbfPjG6YZOI4R3fV7lZSkLt2GrGATKXSmJgCca3UlncK20K0DjoEu30yZkcmmXgfg7VR7NroJIBxuo9SXcwmQV3EWukatBVmIsz0Yp4Y22O672hTvUGjz7ZMZj3rLQWLrrRAjDVlKbi9bcyzdRp6bEEFlPjJhDSKu98GDLRuXhjkNEQ6ZPmEvTwJrGrx4+rr1yetCZTy2HqmMmk7zNlBXwDo6x297u58s5vV73Q5PFv0HbvthXeZxHeCRX4Dm20GySb78hK8/AuFcSaC8Zg34K18B9MUGu3wAhlzA+Pdy/E/Z4/fV+e/itsQNi/KRphAqVjN3OJ/fj2unn+ujZyVd0+mI1KWoxls8N/3rdY6lbPyvi14kTuEDf8tx8twGFdYPijA+JTjh/Awqqod8Id/fl4V+wfxw/3P5+fzw4D5FbXx4Or6EnquDgfiOBKlIlFV9OFibUy8qgyleAKrfXn8Ac4R2qrCBvcLcFzSauOCP+eP1RTYzPl1cIpC8/311UG0D/FhFR5cXVh0/foQD+JGmHNdhmN+vTbo5TXSclgkZdVlePBwadD7b3xQqbDjcMxfYS2h8aCmPI/CRi0MztHT4Zi8Nb42LIxmOOYXpPb1AD0RtiZfPgyOLMlG+BvVxOvx9dwE/7euU3sa/B0mX/AB/wi8QpivB7Vz3oRXDSafAq/W6+cfg5pVQ7K3+3bN7mZgsOdMVcP8xSNRQ+Ypeo/r4LP1esWqcKyW005Bxl5cC69YHSw2U5Ju96ZLcnNbp/lxxWrhl8542plutzdGxoDjKvyHNcGd7s1Nd9sBOpWsHmanwKN3w9bsrjF7+z74dmOivNlYp9+peToiYWz5ITj9Fht/Bh59AO6k8Ob98C0ibWTa/YjZy0w2Hzfbev3BgEG23U9o3nzG5+57o73Z5tL5RMAY63wiYKiUT8CjT2hGuN8Fi+lNupQhyHPMT4e/3G7HBblV74Bh5BcjQ6bore47J4P3cb3Q103TWHoTp8WwXvB8pRuGhkcOlk6QVvNpVHpeUzzAOWwncGc0mm6W5n7fxAJ3xDKNi6KzItvN6UbZT/qjNGCb5Xa63eCavPgwlkiUd+995u+zdgqPttvRhh4WuCLBVyzdEVATT0tSJN0RLhQlbeXJBJ5ubsZLA8fmURuwpAvYhw8p9pF9iDFwVA7YeMnk6ADGKyzDohbesuVyNDYzPR9i4YiaqgJz6vZ1Bm+WnY41O7l9QWSygCkEKYe9fTKQPWMUApYC8Jmn0S7CMkofcHUWMMjUmO0LiDZZi6gZlsymWobQzAQe0TZXCBgzcG3A0ofWHDYX6JiZwxwupErZ9dMIJ3muh03g/RCwiKxgs0ng5Xi5pPJE7eVmW3WmK9obMVWblCc8SfNMAUOeZRRmlviRMcJ0SWXV4QE01RzK/2s96/yYt3Lu+xYsbTx9UZqgxJvwUIUeXlitwlfwxldK+mEoPREJaofCU9SlPE1rUSkzLYE9IT0fd9WA0Y3tlmFF+JEfMsxmGALuezRGTd+DoX4kchhdWCk+CKUTWOiQKWlgBtiMoelZOFsYMEZoFQqGi8NapkJrI/zAnX5I71TQuOkfoqlDMjvbSVjp2MovHZa/cSqloqZ/DCgOS+Qwaj7fFqrp+maES+k1aobP5DSlQ4ZR5GGjFkgIbd/o83Ws4LaIlNIaF0GszKT0iw4R4Pgxv0JwoSIN1OPMQ6K54P6QS+4h5YLjEMmzk1IYOeY+3PYwwQ+5wKKgVcBlGHohl5HEL6dVIQqTMhjbYdaPGo1ECtMIi7Quw5iUwljswlgUCtpZGRfog3XS4zSNaw2zyT4de551LysS6VFYkF0hUBTKQyFQn8+1tB8p2gKtiMoeJ3qm99h6pmUvy12n/dfIbLGV1T0sfvoLx4yGxOp4PP4AAAAASUVORK5CYII=', 'base64') };

app.get('/cert/:name.png', async (req, res) => {
  const emb = CERT_PNG[req.params.name]; if (emb) { res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800' }); return res.send(emb); }
  const src = CERT_SRC[req.params.name]; if (!src) return res.status(404).end();
  try {
    let c = CERT_CACHE[req.params.name];
    if (!c) { const r = await fetch(src, { headers: { Accept: 'image/png,image/*;q=0.5' } }); if (!r.ok) throw new Error('HTTP ' + r.status); c = { type: r.headers.get('content-type') || 'image/png', buf: Buffer.from(await r.arrayBuffer()) }; CERT_CACHE[req.params.name] = c; }
    res.set({ 'Content-Type': c.type, 'Cache-Control': 'public, max-age=604800' }); res.send(c.buf);
  } catch (e) { res.status(502).end(); }
});
app.get('/signature', (req, res) => res.type('html').send('<!doctype html><meta charset="utf-8"><title>Signature e-mail</title><body style="margin:40px;background:#fff;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222"><p>Bonjour,</p><p>[corps du message]</p><p>Cordialement,</p>' + signatureHtml() + '</body>'));

// JSON mal formé
app.use((e, req, res, next) => res.status(400).json(err(null, -32700, 'JSON invalide')));

app.listen(PORT, () => {
  log('Serveur Sellsy-Odys-MCP ' + VERSION + ' démarré sur le port ' + PORT);
  log('Sellsy : ' + (env.SELLSY_ID && env.SELLSY_SECRET ? 'identifiants présents' : 'IDENTIFIANTS MANQUANTS'));
  if (!env.ODYS_KEY) log('ODYS_KEY MANQUANTE : toutes les requêtes /mcp seront refusées');
  else if (env.ODYS_KEY.length < 24) log('ATTENTION : ODYS_KEY trop courte, utilisez au moins 24 caractères aléatoires');
});

export default app;
