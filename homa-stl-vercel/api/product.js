module.exports = async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const url = req.query && req.query.url;

  if (!url || !url.includes('homa.pt')) {
    res.status(400).json({ error: 'URL inválido.' });
    return;
  }

  const pidMatch = url.match(/-(\d{5,7})\.html/);
  if (!pidMatch) {
    res.status(400).json({ error: 'Não foi possível extrair o ID do produto do URL.' });
    return;
  }
  const pid = pidMatch[1];

  const fmt = function(v) {
    if (!v && v !== 0) return '';
    const n = parseFloat(String(v).replace(',', '.'));
    return isNaN(n) ? '' : '\u20AC' + n.toFixed(2).replace('.', ',');
  };

  let name = '', price = '', oldPrice = '', image = '';

  // 1. SFCC Product-Variation JSON endpoint
  try {
    const sfccUrl = 'https://www.homa.pt/on/demandware.store/Sites-homa-Site/pt_PT/Product-Variation?pid=' + pid + '&quantity=1&format=ajax';
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
      if (text.trim().startsWith('{')) {
        const data = JSON.parse(text);
        if (data.product) {
          const p = data.product;
          name = p.productName || p.name || '';
          if (p.price) {
            if (p.price.sales) price = fmt(p.price.sales.value);
            if (p.price.list && p.price.list.value !== (p.price.sales && p.price.sales.value)) {
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

  // 2. Parse HTML page
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

      if (!price) {
        const inlineSales = html.match(/["']sales["']\s*:\s*\{[^}]*["']value["']\s*:\s*([\d.]+)/);
        const inlineList  = html.match(/["']list["']\s*:\s*\{[^}]*["']value["']\s*:\s*([\d.]+)/);
        if (inlineSales) price = fmt(inlineSales[1]);
        if (inlineList && inlineList[1] !== (inlineSales && inlineSales[1])) oldPrice = fmt(inlineList[1]);
      }

      if (!price) {
        const simplePriceMatch = html.match(/["']price["']\s*:\s*["']([\d.]+)["']/);
        if (simplePriceMatch) price = fmt(simplePriceMatch[1]);
      }

      if (!name) {
        const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
                     || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
        if (ogTitle) name = ogTitle[1].replace(/\s*\|.*$/, '').trim();
      }
      if (!name) {
        const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
        if (titleMatch) name = titleMatch[1].replace(/\s*\|.*$/, '').trim();
      }

      if (!image) {
        const ogImg = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
                   || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
        if (ogImg) image = ogImg[1];
      }
      if (!image) {
        const dwImg = html.match(/https:\/\/[^"'\s]*demandware[^"'\s]*\/images\/large\/[^"'\s]+\.jpg/i);
        if (dwImg) image = dwImg[0];
      }

      // JSON-LD
      if (!price) {
        const ldRe = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
        let ldMatch;
        while ((ldMatch = ldRe.exec(html)) !== null) {
          try {
            let data = JSON.parse(ldMatch[1]);
            if (data['@graph']) data = data['@graph'];
            const items = Array.isArray(data) ? data : [data];
            for (let i = 0; i < items.length; i++) {
              const item = items[i];
              if (item['@type'] !== 'Product') continue;
              if (!name && item.name) name = item.name;
              const img2 = Array.isArray(item.image) ? item.image[0] : item.image;
              if (!image) image = (typeof img2 === 'object' ? img2.url || img2.contentUrl : img2) || '';
              const offers = Array.isArray(item.offers) ? item.offers[0] : item.offers;
              if (offers && !price) {
                price = fmt(offers.price);
                if (offers.priceSpecification) {
                  const specs = Array.isArray(offers.priceSpecification) ? offers.priceSpecification : [offers.priceSpecification];
                  for (let j = 0; j < specs.length; j++) {
                    const s = specs[j];
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

  // 3. Ensure image is absolute URL
  if (image && !image.startsWith('http')) {
    image = 'https://www.homa.pt' + (image.startsWith('/') ? '' : '/') + image;
  }

  // 4. Fallback image from Demandware pattern
  if (!image && pid) {
    image = 'https://www.homa.pt/dw/image/v2/BFDH_PRD/on/demandware.static/-/Sites-homa-catalog/default/images/large/' + pid + '_homa_1.jpg?sw=860&sh=860&sm=fit';
  }

  if (!name) {
    res.status(404).json({ error: 'Produto não encontrado.' });
    return;
  }

  res.status(200).json({ name, price, oldPrice, image });
};
