// api/proxy.js
export default async function handler(req, res) {
  // Enable CORS for all origins
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD, PATCH');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', '*');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { url, method = 'GET' } = req.query;
  
  if (!url) {
    return res.status(400).json({ error: 'URL parameter is required' });
  }

  try {
    // Validate and construct URL
    const targetUrl = new URL(decodeURIComponent(url));
    
    // Prepare headers - copy most from original request
    const headers = {
      'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': req.headers['accept'] || '*/*',
      'Accept-Language': req.headers['accept-language'] || 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': req.headers['cache-control'] || 'no-cache',
      'Pragma': 'no-cache',
    };

    // Copy authorization and other important headers
    if (req.headers['authorization']) headers['Authorization'] = req.headers['authorization'];
    if (req.headers['cookie']) headers['Cookie'] = req.headers['cookie'];
    if (req.headers['referer']) {
      // Rewrite referer to original domain
      const referer = req.headers['referer'];
      if (referer.includes('/api/proxy?url=')) {
        const originalReferer = decodeURIComponent(referer.split('/api/proxy?url=')[1].split('&')[0]);
        headers['Referer'] = originalReferer;
      }
    }

    // Handle range requests for video/audio
    if (req.headers['range']) {
      headers['Range'] = req.headers['range'];
    }

    const fetchOptions = {
      method: method.toUpperCase(),
      headers,
      redirect: 'manual', // Handle redirects manually
    };

    // Add body for POST/PUT requests
    if (['POST', 'PUT', 'PATCH'].includes(method.toUpperCase()) && req.body) {
      if (typeof req.body === 'string') {
        fetchOptions.body = req.body;
      } else {
        fetchOptions.body = JSON.stringify(req.body);
      }
      if (!headers['Content-Type']) {
        headers['Content-Type'] = req.headers['content-type'] || 'application/json';
      }
    }

    // Make the request
    const response = await fetch(targetUrl.toString(), fetchOptions);
    
    // Handle redirects
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (location) {
        let redirectUrl;
        if (location.startsWith('http')) {
          redirectUrl = location;
        } else if (location.startsWith('/')) {
          redirectUrl = `${targetUrl.protocol}//${targetUrl.host}${location}`;
        } else {
          redirectUrl = new URL(location, targetUrl).toString();
        }
        return res.redirect(302, `/api/proxy?url=${encodeURIComponent(redirectUrl)}`);
      }
    }

    // Copy response status
    res.status(response.status);

    // Copy important response headers
    const responseHeaders = {};
    response.headers.forEach((value, key) => {
      const lowerKey = key.toLowerCase();
      
      // Skip problematic headers
      if ([
        'content-encoding', 
        'content-length', 
        'transfer-encoding',
        'connection',
        'keep-alive',
        'upgrade',
        'x-frame-options',
        'content-security-policy',
        'content-security-policy-report-only'
      ].includes(lowerKey)) {
        return;
      }

      // Rewrite location headers
      if (lowerKey === 'location') {
        if (value.startsWith('http')) {
          responseHeaders[key] = `/api/proxy?url=${encodeURIComponent(value)}`;
        } else if (value.startsWith('/')) {
          const baseUrl = `${targetUrl.protocol}//${targetUrl.host}`;
          responseHeaders[key] = `/api/proxy?url=${encodeURIComponent(baseUrl + value)}`;
        } else {
          responseHeaders[key] = value;
        }
        return;
      }

      // Copy set-cookie headers (important for sessions)
      if (lowerKey === 'set-cookie') {
        responseHeaders[key] = value;
        return;
      }

      responseHeaders[key] = value;
    });

    // Set CORS headers
    responseHeaders['Access-Control-Allow-Origin'] = '*';
    responseHeaders['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS, HEAD, PATCH';
    responseHeaders['Access-Control-Allow-Headers'] = '*';
    responseHeaders['Access-Control-Expose-Headers'] = '*';

    // Apply headers
    Object.entries(responseHeaders).forEach(([key, value]) => {
      res.setHeader(key, value);
    });

    const contentType = response.headers.get('content-type') || '';
    
    // Handle HTML - rewrite URLs and inject proxy scripts
    if (contentType.includes('text/html')) {
      let html = await response.text();
      
      const baseUrl = `${targetUrl.protocol}//${targetUrl.host}`;
      const currentPath = targetUrl.pathname.substring(0, targetUrl.pathname.lastIndexOf('/') + 1);
      const currentUrl = `${baseUrl}${currentPath}`;

      // More comprehensive URL rewriting
      html = html.replace(/(href|src|action|data-src|data-href)=(["'])([^"']*?)\2/gi, (match, attr, quote, url) => {
        if (url.startsWith('javascript:') || url.startsWith('mailto:') || url.startsWith('tel:') || url.startsWith('#')) {
          return match;
        }
        
        let newUrl;
        if (url.startsWith('http://') || url.startsWith('https://')) {
          newUrl = url;
        } else if (url.startsWith('//')) {
          newUrl = targetUrl.protocol + url;
        } else if (url.startsWith('/')) {
          newUrl = baseUrl + url;
        } else if (url) {
          newUrl = currentUrl + url;
        } else {
          return match;
        }
        
        return `${attr}=${quote}/api/proxy?url=${encodeURIComponent(newUrl)}${quote}`;
      });

      // Handle CSS url() references
      html = html.replace(/url\((['"]?)([^)]*?)\1\)/gi, (match, quote, url) => {
        if (url.startsWith('data:') || url.startsWith('javascript:')) return match;
        
        let newUrl;
        if (url.startsWith('http://') || url.startsWith('https://')) {
          newUrl = url;
        } else if (url.startsWith('//')) {
          newUrl = targetUrl.protocol + url;
        } else if (url.startsWith('/')) {
          newUrl = baseUrl + url;
        } else {
          newUrl = currentUrl + url;
        }
        
        return `url(${quote}/api/proxy?url=${encodeURIComponent(newUrl)}${quote})`;
      });

      // Comprehensive proxy injection script
      const proxyScript = `
        <script>
          (function() {
            const PROXY_PREFIX = '/api/proxy?url=';
            const ORIGINAL_ORIGIN = '${targetUrl.origin}';
            const ORIGINAL_HOST = '${targetUrl.host}';
            
            // Override location object
            const originalLocation = window.location;
            Object.defineProperty(window, 'location', {
              get: function() {
                return new Proxy(originalLocation, {
                  get: function(target, prop) {
                    if (prop === 'href') {
                      const params = new URLSearchParams(target.search);
                      return decodeURIComponent(params.get('url') || target.href);
                    }
                    if (prop === 'origin' || prop === 'host' || prop === 'hostname') {
                      return ORIGINAL_HOST;
                    }
                    if (prop === 'protocol') {
                      return '${targetUrl.protocol}';
                    }
                    return target[prop];
                  },
                  set: function(target, prop, value) {
                    if (prop === 'href') {
                      if (value.startsWith('http')) {
                        target.href = PROXY_PREFIX + encodeURIComponent(value);
                      } else {
                        target.href = PROXY_PREFIX + encodeURIComponent(ORIGINAL_ORIGIN + value);
                      }
                      return true;
                    }
                    target[prop] = value;
                    return true;
                  }
                });
              },
              configurable: true
            });

            // Override fetch
            const originalFetch = window.fetch;
            window.fetch = function(url, options = {}) {
              if (typeof url === 'string') {
                if (url.startsWith('/') && !url.startsWith('/api/proxy')) {
                  url = PROXY_PREFIX + encodeURIComponent(ORIGINAL_ORIGIN + url);
                } else if (url.startsWith('http') && !url.includes('/api/proxy')) {
                  url = PROXY_PREFIX + encodeURIComponent(url);
                } else if (!url.startsWith('http') && !url.startsWith('/')) {
                  url = PROXY_PREFIX + encodeURIComponent(ORIGINAL_ORIGIN + '/' + url);
                }
              }
              return originalFetch(url, options);
            };

            // Override XMLHttpRequest
            const OriginalXMLHttpRequest = window.XMLHttpRequest;
            window.XMLHttpRequest = function() {
              const xhr = new OriginalXMLHttpRequest();
              const originalOpen = xhr.open;
              xhr.open = function(method, url, ...args) {
                if (typeof url === 'string') {
                  if (url.startsWith('/') && !url.startsWith('/api/proxy')) {
                    url = PROXY_PREFIX + encodeURIComponent(ORIGINAL_ORIGIN + url);
                  } else if (url.startsWith('http') && !url.includes('/api/proxy')) {
                    url = PROXY_PREFIX + encodeURIComponent(url);
                  }
                }
                return originalOpen.call(this, method, url, ...args);
              };
              return xhr;
            };

            // Handle form submissions
            document.addEventListener('submit', function(e) {
              const form = e.target;
              const action = form.action;
              if (action && !action.includes('/api/proxy')) {
                e.preventDefault();
                let newAction;
                if (action.startsWith('http')) {
                  newAction = PROXY_PREFIX + encodeURIComponent(action);
                } else if (action.startsWith('/')) {
                  newAction = PROXY_PREFIX + encodeURIComponent(ORIGINAL_ORIGIN + action);
                } else {
                  newAction = PROXY_PREFIX + encodeURIComponent(window.location.href + '/' + action);
                }
                form.action = newAction;
                form.submit();
              }
            });

            // Handle dynamic element creation
            const originalCreateElement = document.createElement;
            document.createElement = function(tagName) {
              const element = originalCreateElement.call(this, tagName);
              
              if (tagName.toLowerCase() === 'script' || tagName.toLowerCase() === 'img' || 
                  tagName.toLowerCase() === 'iframe' || tagName.toLowerCase() === 'video' || 
                  tagName.toLowerCase() === 'audio' || tagName.toLowerCase() === 'source') {
                
                const originalSetAttribute = element.setAttribute;
                element.setAttribute = function(name, value) {
                  if ((name === 'src' || name === 'href') && value && typeof value === 'string') {
                    if (value.startsWith('/') && !value.startsWith('/api/proxy')) {
                      value = PROXY_PREFIX + encodeURIComponent(ORIGINAL_ORIGIN + value);
                    } else if (value.startsWith('http') && !value.includes('/api/proxy')) {
                      value = PROXY_PREFIX + encodeURIComponent(value);
                    }
                  }
                  return originalSetAttribute.call(this, name, value);
                };
              }
              
              return element;
            };

            // Handle WebSocket (basic support)
            const OriginalWebSocket = window.WebSocket;
            window.WebSocket = function(url, protocols) {
              // Convert ws:// to http:// for proxy
              if (typeof url === 'string') {
                if (url.startsWith('ws://')) {
                  url = 'http://' + url.substring(5);
                } else if (url.startsWith('wss://')) {
                  url = 'https://' + url.substring(6);
                }
                if (!url.includes('/api/proxy')) {
                  url = PROXY_PREFIX + encodeURIComponent(url);
                }
              }
              return new OriginalWebSocket(url, protocols);
            };
          })();
        </script>
      `;

      // Inject base tag and scripts
      const baseTag = `<base href="${targetUrl.origin}${targetUrl.pathname}">`;
      
      if (html.includes('<head>')) {
        html = html.replace(/<head>/i, `<head>${baseTag}${proxyScript}`);
      } else if (html.includes('<html>')) {
        html = html.replace(/<html([^>]*)>/i, `<html$1>${baseTag}${proxyScript}`);
      } else {
        html = baseTag + proxyScript + html;
      }

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    }
    // Handle CSS
    else if (contentType.includes('text/css')) {
      let css = await response.text();
      const baseUrl = `${targetUrl.protocol}//${targetUrl.host}`;
      const currentPath = targetUrl.pathname.substring(0, targetUrl.pathname.lastIndexOf('/') + 1);
      const currentUrl = `${baseUrl}${currentPath}`;

      css = css.replace(/url\((['"]?)([^)]*?)\1\)/gi, (match, quote, url) => {
        if (url.startsWith('data:')) return match;
        
        let newUrl;
        if (url.startsWith('http://') || url.startsWith('https://')) {
          newUrl = url;
        } else if (url.startsWith('//')) {
          newUrl = targetUrl.protocol + url;
        } else if (url.startsWith('/')) {
          newUrl = baseUrl + url;
        } else {
          newUrl = currentUrl + url;
        }
        
        return `url(${quote}/api/proxy?url=${encodeURIComponent(newUrl)}${quote})`;
      });

      res.setHeader('Content-Type', 'text/css');
      return res.send(css);
    }
    // Handle JavaScript
    else if (contentType.includes('application/javascript') || contentType.includes('text/javascript')) {
      const js = await response.text();
      // For now, pass through JS as-is. Could add more rewriting here if needed.
      return res.send(js);
    }
    // Handle all other content (images, videos, etc.)
    else {
      const buffer = await response.arrayBuffer();
      return res.send(Buffer.from(buffer));
    }

  } catch (error) {
    console.error('Proxy error:', error);
    return res.status(500).json({ 
      error: 'Failed to fetch the requested URL',
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}
