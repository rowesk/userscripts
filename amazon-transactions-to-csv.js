// ==UserScript==
// @name         Amazon Transactions CSV Export (Max 200)
// @namespace    https://local.amazon-tools
// @version      1.1.0
// @description  Auto-scroll and export Amazon transactions (date, card, order, amount) to CSV.
// @author       local
// @match        https://*.amazon.co.uk/cpe/yourpayments/transactions*
// @match        https://*.amazon.com/cpe/yourpayments/transactions*
// @match        https://*.amazon.de/cpe/yourpayments/transactions*
// @match        https://*.amazon.fr/cpe/yourpayments/transactions*
// @match        https://*.amazon.it/cpe/yourpayments/transactions*
// @match        https://*.amazon.es/cpe/yourpayments/transactions*
// @match        https://*.amazon.ca/cpe/yourpayments/transactions*
// @match        https://*.amazon.co.jp/cpe/yourpayments/transactions*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const MAX_TRANSACTIONS = 200;
  const WAIT_MS = 900;
  const STALL_LIMIT = 8;

  const MONTHS = {
    Jan: '01',
    Feb: '02',
    Mar: '03',
    Apr: '04',
    May: '05',
    Jun: '06',
    Jul: '07',
    Aug: '08',
    Sep: '09',
    Oct: '10',
    Nov: '11',
    Dec: '12',
  };

  const AMOUNT_REGEX = /[+-]?\s*(?:[$£€]|USD|GBP|EUR)\s*\d[\d,]*(?:\.\d{2})?/i;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function normalizeSpace(value) {
    return (value || '').replace(/\s+/g, ' ').trim();
  }

  function parseDateToISO(raw) {
    const text = normalizeSpace(raw);
    const match = text.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
    if (!match) return '';

    const day = String(Number(match[1])).padStart(2, '0');
    const month = MONTHS[match[2]];
    const year = match[3];

    return month ? `${year}-${month}-${day}` : '';
  }

  function csvEscape(value) {
    const str = value == null ? '' : String(value);
    if (/[",\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  function buildCsv(rows) {
    const maxProducts = rows.reduce(
      (max, row) => Math.max(max, Array.isArray(row.products) ? row.products.length : 0),
      0
    );
    const productHeaders = Array.from({ length: maxProducts }, (_, i) => `product_${i + 1}`);
    const header = ['date', 'card_details', 'order_number', 'total_amount', ...productHeaders];
    const lines = [header.join(',')];

    for (const row of rows) {
      const productValues = Array.isArray(row.products) ? row.products : [];
      const paddedProducts = Array.from({ length: maxProducts }, (_, i) => productValues[i] || '');
      lines.push(
        [row.date, row.cardDetails, row.orderNumber, row.totalAmount, ...paddedProducts]
          .map(csvEscape)
          .join(',')
      );
    }

    return lines.join('\n');
  }

  function getScrollableContainer(anchorElement) {
    let current = anchorElement;

    while (current && current !== document.body) {
      const style = window.getComputedStyle(current);
      const overflowY = style.overflowY;
      const canScroll =
        (overflowY === 'auto' || overflowY === 'scroll') &&
        current.scrollHeight > current.clientHeight + 8;

      if (canScroll) {
        return current;
      }

      current = current.parentElement;
    }

    return document.scrollingElement || document.documentElement;
  }

  function extractTransaction(linkEl) {
    const row = linkEl.querySelector('[data-testid="transaction-link-content-wrapper"]') || linkEl;

    const firstText = row.querySelector('span[data-testid="text"], div[data-testid="text"]');
    const date = parseDateToISO(firstText ? firstText.textContent : '');

    const cardName = normalizeSpace(
      row.querySelector('[data-testid="method-details-name"]')?.textContent
    );
    const cardPrefix = normalizeSpace(
      row.querySelector('[data-testid="method-details-prefix"]')?.textContent
    );
    const cardNumber = normalizeSpace(
      row.querySelector('[data-testid="method-details-number"]')?.textContent
    );
    const cardDetails = `${cardName}${cardPrefix}${cardNumber}`;

    const orderTextEl = Array.from(row.querySelectorAll('[data-testid="text"], span, div')).find(
      (el) => /Order\s*#/i.test(el.textContent || '')
    );
    const orderText = normalizeSpace(orderTextEl?.textContent || '');
    const orderMatch = orderText.match(/Order\s*#\s*([A-Za-z0-9-]+)/i);
    const orderNumber = orderMatch ? orderMatch[1] : '';

    const amountEl = Array.from(row.querySelectorAll('[data-testid="text"], span, div')).find((el) =>
      AMOUNT_REGEX.test(normalizeSpace(el.textContent || ''))
    );
    const amountRaw = normalizeSpace(amountEl?.textContent || '');
    const totalAmount = parseAmountValue(amountRaw);

    if (!date && !orderNumber && !totalAmount && !cardDetails) {
      return null;
    }

    return { date, cardDetails, orderNumber, totalAmount, products: [] };
  }

  function parseAmountValue(rawText) {
    const text = normalizeSpace(rawText);
    const match = text.match(/([+-]?)\s*(?:[$£€]|USD|GBP|EUR)?\s*(\d[\d,]*(?:\.\d{2})?)/i);
    if (!match) return '';

    const sign = match[1] || '';
    const value = match[2].replace(/,/g, '');
    return `${sign}${value}`;
  }

  function getOrderDetailsUrl(orderNumber) {
    return `${window.location.origin}/your-orders/order-details?orderID=${encodeURIComponent(orderNumber)}`;
  }

  function parseProductsFromOrderHtml(htmlText) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlText, 'text/html');

    const primary = Array.from(doc.querySelectorAll('[data-component="itemTitle"] a.a-link-normal'))
      .map((el) => normalizeSpace(el.textContent))
      .filter(Boolean);
    if (primary.length) return [...new Set(primary)];

    const fallback = Array.from(doc.querySelectorAll('a.a-link-normal[href*="/dp/"]'))
      .map((el) => normalizeSpace(el.textContent))
      .filter((text) => text.length > 2);
    return [...new Set(fallback)];
  }

  async function fetchOrderProducts(orderNumber) {
    if (!orderNumber) return [];

    const url = getOrderDetailsUrl(orderNumber);
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
    });
    if (!response.ok) return [];

    const html = await response.text();
    return parseProductsFromOrderHtml(html);
  }

  async function enrichTransactionsWithProducts(rows, onProgress) {
    const cache = new Map();
    const uniqueOrders = [...new Set(rows.map((row) => row.orderNumber).filter(Boolean))];

    let done = 0;
    for (const orderNumber of uniqueOrders) {
      try {
        const products = await fetchOrderProducts(orderNumber);
        cache.set(orderNumber, products);
      } catch (error) {
        console.error(`Failed fetching order details for ${orderNumber}:`, error);
        cache.set(orderNumber, []);
      }
      done += 1;
      if (typeof onProgress === 'function') onProgress(done, uniqueOrders.length);
      await sleep(150);
    }

    return rows.map((row) => ({
      ...row,
      products: cache.get(row.orderNumber) || [],
    }));
  }

  async function collectTransactions(maxTransactions) {
    const records = [];
    const seen = new Set();

    const seed = document.querySelector('[data-testid="transaction-link"]');
    const scroller = getScrollableContainer(seed || document.body);

    let stallCount = 0;
    let lastCount = 0;

    while (records.length < maxTransactions && stallCount < STALL_LIMIT) {
      const links = Array.from(document.querySelectorAll('[data-testid="transaction-link"]'));

      for (const link of links) {
        const tx = extractTransaction(link);
        if (!tx) continue;

        const key = `${tx.date}|${tx.cardDetails}|${tx.orderNumber}|${tx.totalAmount}`;
        if (seen.has(key)) continue;

        seen.add(key);
        records.push(tx);

        if (records.length >= maxTransactions) break;
      }

      if (records.length === lastCount) {
        stallCount += 1;
      } else {
        stallCount = 0;
        lastCount = records.length;
      }

      if (records.length >= maxTransactions || stallCount >= STALL_LIMIT) {
        break;
      }

      if (scroller === document.scrollingElement || scroller === document.documentElement) {
        window.scrollTo(0, document.body.scrollHeight);
      } else {
        scroller.scrollTop = scroller.scrollHeight;
      }

      await sleep(WAIT_MS);
    }

    return records.slice(0, maxTransactions);
  }

  function downloadCsv(csvText, rowCount) {
    const now = new Date();
    const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const fileName = `amazon-transactions-${rowCount}-${stamp}.csv`;

    const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function createButton() {
    const button = document.createElement('button');
    button.id = 'amazon-txn-csv-export-btn';
    button.textContent = `Export ${MAX_TRANSACTIONS} Txns CSV`;
    button.type = 'button';

    Object.assign(button.style, {
      position: 'fixed',
      right: '16px',
      bottom: '16px',
      zIndex: '2147483647',
      border: '1px solid #111',
      borderRadius: '8px',
      background: '#fff',
      color: '#111',
      fontSize: '13px',
      fontFamily: 'system-ui, sans-serif',
      fontWeight: '600',
      padding: '10px 12px',
      cursor: 'pointer',
      boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
    });

    button.addEventListener('click', async () => {
      if (button.dataset.running === '1') return;
      button.dataset.running = '1';

      const originalText = button.textContent;
      button.textContent = 'Collecting...';

      try {
        const rows = await collectTransactions(MAX_TRANSACTIONS);

        if (!rows.length) {
          button.textContent = 'No transactions found';
          await sleep(1600);
          button.textContent = originalText;
          return;
        }

        button.textContent = 'Loading order items...';
        const enrichedRows = await enrichTransactionsWithProducts(rows, (done, total) => {
          button.textContent = `Loading order items... ${done}/${total}`;
        });

        const csv = buildCsv(enrichedRows);
        downloadCsv(csv, enrichedRows.length);

        button.textContent = `Downloaded ${enrichedRows.length}`;
        await sleep(1800);
      } catch (error) {
        console.error('Failed to export transactions:', error);
        button.textContent = 'Export failed';
        await sleep(1800);
      } finally {
        button.textContent = originalText;
        delete button.dataset.running;
      }
    });

    document.body.appendChild(button);
    return button;
  }

  function init() {
    if (document.getElementById('amazon-txn-csv-export-btn')) return;
    createButton();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
