// api/proxy.js
export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { url, method = 'GET' } = req.query;
  
  if (!url) {
    return res.status(400).json({ error: 'URL parameter is required' });
  }

  try {
    // Validate URL
    const targetUrl = new URL(url);
    
    // Prepare headers (remove some that might cause issues)
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
    };

    // Add custom headers if provided
    if (req.headers['x-proxy-headers']) {
      const customHeaders = JSON.parse(req.headers['x-proxy-headers']);
      Object.assign(headers, customHeaders);
    }

    const fetchOptions = {
      method: method.toUpperCase(),
      headers,
      redirect: 'follow',
    };

    // Add body for POST/PUT requests
    if (['POST', 'PUT', 'PATCH'].includes(method.toUpperCase()) && req.body) {
      fetchOptions.body = JSON.stringify(req.body);
      headers['Content-Type'] = 'application/json';
    }

    // Make the request
    const response = await fetch(targetUrl.toString(), fetchOptions);
    
    // Get response headers
    const responseHeaders = {};
    response.headers.forEach((value, key) => {
      // Skip some headers that might cause issues
      if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(key.toLowerCase())) {
        responseHeaders[key] = value;
      }
    });

    // Set response headers
    Object.entries(responseHeaders).forEach(([key, value]) => {
      res.setHeader(key, value);
    });

    // Handle different content types
    const contentType = response.headers.get('content-type') || '';
    
    if (contentType.includes('text/html')) {
      let html = await response.text();
      
      // Rewrite URLs in HTML to go through proxy
      html = html.replace(/(href|src|action)="([^"]*?)"/gi, (match, attr, url) => {
        if (url.startsWith('http://') || url.startsWith('https://')) {
          return `${attr}="/api/proxy?url=${encodeURIComponent(url)}"`;
        } else if (url.startsWith('/')) {
          const baseUrl = `${targetUrl.protocol}//${targetUrl.host}`;
          return `${attr}="/api/proxy?url=${encodeURIComponent(baseUrl + url)}"`;
        } else if (!url.startsWith('#') && !url.startsWith('mailto:') && !url.startsWith('tel:')) {
          const baseUrl = targetUrl.href.substring(0, targetUrl.href.lastIndexOf('/') + 1);
          return `${attr}="/api/proxy?url=${encodeURIComponent(baseUrl + url)}"`;
        }
        return match;
      });

      // Rewrite CSS url() references
      html = html.replace(/url\((['"]?)([^)]*?)\1\)/gi, (match, quote, url) => {
        if (url.startsWith('http://') || url.startsWith('https://')) {
          return `url(${quote}/api/proxy?url=${encodeURIComponent(url)}${quote})`;
        } else if (url.startsWith('/')) {
          const baseUrl = `${targetUrl.protocol}//${targetUrl.host}`;
          return `url(${quote}/api/proxy?url=${encodeURIComponent(baseUrl + url)}${quote})`;
        } else if (!url.startsWith('data:')) {
          const baseUrl = targetUrl.href.substring(0, targetUrl.href.lastIndexOf('/') + 1);
          return `url(${quote}/api/proxy?url=${encodeURIComponent(baseUrl + url)}${quote})`;
        }
        return match;
      });

      // Add base tag and proxy script
      const baseTag = `<base href="${targetUrl.origin}">`;
      const proxyScript = `
        <script>
          // Intercept form submissions
          document.addEventListener('submit', function(e) {
            const form = e.target;
            const action = form.action;
            if (action && !action.includes('/api/proxy')) {
              e.preventDefault();
              const newAction = '/api/proxy?url=' + encodeURIComponent(action) + '&method=' + (form.method || 'GET');
              form.action = newAction;
              form.submit();
            }
          });

          // Intercept fetch requests
          const originalFetch = window.fetch;
          window.fetch = function(url, options = {}) {
            if (typeof url === 'string' && !url.startsWith('/api/proxy')) {
              if (url.startsWith('http')) {
                url = '/api/proxy?url=' + encodeURIComponent(url);
              } else if (url.startsWith('/')) {
                url = '/api/proxy?url=' + encodeURIComponent(window.location.origin + url);
              }
            }
            return originalFetch(url, options);
          };
        </script>
      `;

      html = html.replace(/<head>/i, `<head>${baseTag}${proxyScript}`);
      
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(response.status).send(html);
    } 
    else if (contentType.includes('text/css')) {
      let css = await response.text();
      
      // Rewrite URLs in CSS
      css = css.replace(/url\((['"]?)([^)]*?)\1\)/gi, (match, quote, url) => {
        if (url.startsWith('http://') || url.startsWith('https://')) {
          return `url(${quote}/api/proxy?url=${encodeURIComponent(url)}${quote})`;
        } else if (url.startsWith('/')) {
          const baseUrl = `${targetUrl.protocol}//${targetUrl.host}`;
          return `url(${quote}/api/proxy?url=${encodeURIComponent(baseUrl + url)}${quote})`;
        } else if (!url.startsWith('data:')) {
          const baseUrl = targetUrl.href.substring(0, targetUrl.href.lastIndexOf('/') + 1);
          return `url(${quote}/api/proxy?url=${encodeURIComponent(baseUrl + url)}${quote})`;
        }
        return match;
      });

      res.setHeader('Content-Type', 'text/css');
      return res.status(response.status).send(css);
    }
    else {
      // For other content types, pipe through as-is
      const buffer = await response.arrayBuffer();
      return res.status(response.status).send(Buffer.from(buffer));
    }

  } catch (error) {
    console.error('Proxy error:', error);
    return res.status(500).json({ 
      error: 'Failed to fetch the requested URL',
      message: error.message 
    });
  }
}
