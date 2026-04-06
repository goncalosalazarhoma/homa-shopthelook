exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }

  const url = event.queryStringParameters && event.queryStringParameters.url;

  if (!url || !url.includes('homa.pt')) {
    return {
      statusCode: 400,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'URL inválido.' }),
    };
  }

  // extract product ID from URL: /nome-produto-XXXXXX.html
  const pidMatch = url.match(/-(\d{5,7})\.html/);
  if (!pidMatch) {
    return {
      statusCode: 400,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Não foi possível extrair o ID do produto do URL.' }),
    };
  }
  const pid = pidMatch[1];

  const fmt = (v) => {
    if (!v && v !== 0) return '';
    const n = parseFloat(String(v).replace(',', '.'));
    return isNaN(n) ? '' : '€' + n.toFixed(2).replace('.', ',');
  };

  let name = '', price = '', oldPrice = '', image = '';

  // ── 1. SFCC Product-Variation JSON endpoint ──
  try {
    const sfccUrl = `https://www.homa.pt/on/demandware.store/Sites-homa-Site/pt_PT/Product-Variation?pid=${pid}&quantity=1&format=ajax`;
    const sfccRes = await fetch(sfccUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/javascript, */*',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': url,
      },
    });
    if (sfccRes.ok) {
      const text = await sfccRes.text();
      // response may be HTML or JSON depending on session
      if (text.trim().startsWith('{')) {
        const data = JSON.parse(text);
        if (data.product) {
          const p = data.product;
          name = p.productName || p.name || '';
          if (p.price) {
            if (p.price.sales) price = fmt(p.price.sales.value);
            if (p.price.list && p.price.list.value !== p.price.sales?.value) {
              oldPrice = fmt(p.price.list.value);
            }
          }
          if (p.images && p.images.large && p.images.large[0]) {
            image = p.images.large[0].url || p.images.large[0].absURL || '';
          }
        }
      }
    }
  } catch (e) {}

  // ── 2. SFCC Product-Show JSON endpoint ──
  if (!name || !price) {
    try {
      const sfccUrl2 = `https://www.homa.pt/on/demandware.store/Sites-homa-Site/pt_PT/Product-Show?pid=${pid}&format=ajax`;
      const sfccRes2 = await fetch(sfccUrl2, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml,*/*',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': url,
        },
      });
      if (sfccRes2.ok) {
        const text2 = await sfccRes2.text();
        // look for price patterns in the HTML/JSON response
        const salesMatch = text2.match(/"sales"\s*:\s*\{[^}]*"value"\s*:\s*([\d.]+)/);
        const listMatch  = text2.match(/"list"\s*:\s*\{[^}]*"value"\s*:\s*([\d.]+)/);
        if (salesMatch && !price) price = fmt(salesMatch[1]);
        if (listMatch && listMatch[1] !== salesMatch?.[1]) oldPrice = fmt(listMatch[1]);
        // extract name
        if (!name) {
          const nameMatch = text2.match(/"productName"\s*:\s*"([^"]+)"/);
          if (nameMatch) name = nameMatch[1];
        }
      }
    } catch (e) {}
  }

  // ── 3. Parse HTML source for SFCC inline script data ──
  // SFCC injects product data in a <script> tag before GTM fires
  if (!price || !name || !image) {
    try {
      const pageRes = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'pt-PT,pt;q=0.9',
        },
      });
      const html = await pageRes.text();

      // SFCC product data object pattern: {id:"470193",name:"...",price:{sales:{value:12.00},list:...}}
      if (!price) {
        const inlineSales = html.match(/["']sales["']\s*:\s*\{[^}]*["']value["']\s*:\s*([\d.]+)/);
        const inlineList  = html.match(/["']list["']\s*:\s*\{[^}]*["']value["']\s*:\s*([\d.]+)/);
        if (inlineSales) price    = fmt(inlineSales[1]);
        if (inlineList && inlineList[1] !== inlineSales?.[1]) oldPrice = fmt(inlineList[1]);
      }

      // price in format: "price":"12.00" or price:12.00
      if (!price) {
        const simplePriceMatch = html.match(/["']price["']\s*:\s*["']([\d.]+)["']/);
        if (simplePriceMatch) price = fmt(simplePriceMatch[1]);
      }

      // name from og:title or <title>
      if (!name) {
        const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
                     || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
        if (ogTitle) name = ogTitle[1].replace(/\s*\|.*$/, '').trim();
      }
      if (!name) {
        const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
        if (titleMatch) name = titleMatch[1].replace(/\s*\|.*$/, '').trim();
      }

      // image from og:image or Demandware pattern
      if (!image) {
        const ogImg = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
                   || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
        if (ogImg) image = ogImg[1];
      }
      if (!image) {
        const dwImg = html.match(/https:\/\/[^"'\s]*demandware[^"'\s]*\/images\/large\/[^"'\s]+\.jpg/i);
        if (dwImg) image = dwImg[0];
      }

      // JSON-LD last resort for price
      if (!price) {
        const ldMatches = [...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
        for (const match of ldMatches) {
          try {
            let data = JSON.parse(match[1]);
            if (data['@graph']) data = data['@graph'];
            const items = Array.isArray(data) ? data : [data];
            for (const item of items) {
              if (item['@type'] !== 'Product') continue;
              if (!name && item.name) name = item.name;
              const img2 = Array.isArray(item.image) ? item.image[0] : item.image;
              if (!image) image = (typeof img2 === 'object' ? img2.url || img2.contentUrl : img2) || '';
              const offers = Array.isArray(item.offers) ? item.offers[0] : item.offers;
              if (offers && !price) {
                price = fmt(offers.price);
                if (offers.priceSpecification) {
                  const specs = Array.isArray(offers.priceSpecification) ? offers.priceSpecification : [offers.priceSpecification];
                  for (const s of specs) {
                    if (s.priceType && s.priceType.includes('RegularPrice')) {
                      const op = fmt(s.price);
                      if (op && op !== price) oldPrice = op;
                    }
                  }
                }
              }
              if (name && price) break;
            }
          } catch (e) {}
          if (name && price) break;
        }
      }
    } catch (e) {}
  }

  // ── 4. Fallback: construct image URL from known Demandware pattern ──
  // homa.pt image pattern: /dw/image/v2/.../images/large/XXXXXX_slug_homa_1.jpg
  if (!image && pid) {
    image = `https://www.homa.pt/dw/image/v2/BFDH_PRD/on/demandware.static/-/Sites-homa-catalog/default/images/large/${pid}_homa_1.jpg?sw=860&sh=860&sm=fit`;
  }

  if (!name) {
    return {
      statusCode: 404,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Produto não encontrado.' }),
    };
  }

  // ensure image is an absolute URL
  if (image && !image.startsWith('http')) {
    image = 'https://www.homa.pt' + (image.startsWith('/') ? '' : '/') + image;
  }

  return {
    statusCode: 200,
    headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, price, oldPrice, image }),
  };
};
