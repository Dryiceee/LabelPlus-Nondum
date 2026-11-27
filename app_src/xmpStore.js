// One JSON property of ours inside a layer's (or the document's) XMP packet,
// under our own namespace. The SFX editor and the ruby editor each have one.
//
//   const store = xmpStore("http://ns.example/1.0/", "ex");
//   store.read(xmp, "data")          -> the property's text, or null
//   store.write(xmp, text, "data")   -> the packet with it set (null removes)
// Other metadata in the packet stays as it was.

const escapeXml = (text) => String(text)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const unescapeXml = (text) => String(text)
  .replace(/&#x([0-9a-f]+);/gi, (m, hex) => String.fromCodePoint(parseInt(hex, 16)))
  .replace(/&#(\d+);/g, (m, dec) => String.fromCodePoint(parseInt(dec, 10)))
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const EMPTY_PACKET = (body) =>
  "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">" + body + "</rdf:RDF></x:xmpmeta>";

export function xmpStore(namespace, ownPrefix) {
  // The prefix the packet binds to our namespace (an XMP toolkit may rename it)
  function prefixesOf(xmp) {
    const found = [];
    const re = new RegExp("xmlns:([A-Za-z_][\\w.-]*)\\s*=\\s*[\"']" + escapeRegExp(namespace) + "[\"']", "g");
    let match;
    while ((match = re.exec(xmp))) if (found.indexOf(match[1]) < 0) found.push(match[1]);
    return found;
  }

  // Our property, written as an element or (compact form) as an attribute
  function read(xmp, property) {
    const text = String(xmp || "");
    if (!text) return null;
    for (const prefix of prefixesOf(text)) {
      const name = escapeRegExp(prefix + ":" + property);
      const element = new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">").exec(text);
      if (element) return unescapeXml(element[1].trim());
      const attribute = new RegExp("\\s" + name + "\\s*=\\s*\"([^\"]*)\"").exec(text) || new RegExp("\\s" + name + "\\s*=\\s*'([^']*)'").exec(text);
      if (attribute) return unescapeXml(attribute[1]);
    }
    return null;
  }

  const ownDescription = (property, value) =>
    "<rdf:Description rdf:about=\"\" xmlns:" + ownPrefix + "=\"" + namespace + "\">" +
    "<" + ownPrefix + ":" + property + ">" + escapeXml(value) + "</" + ownPrefix + ":" + property + ">" +
    "</rdf:Description>";

  // Drop our property wherever the packet holds it
  function removeProperty(xmp, property) {
    let text = xmp;
    prefixesOf(text).forEach((prefix) => {
      const name = escapeRegExp(prefix + ":" + property);
      text = text.replace(new RegExp("<" + name + "(?:\\s[^>]*)?>[\\s\\S]*?</" + name + ">", "g"), "");
      text = text.replace(new RegExp("<" + name + "\\s*/>", "g"), "");
      text = text.replace(new RegExp("\\s" + name + "\\s*=\\s*(\"[^\"]*\"|'[^']*')", "g"), "");
    });
    return text;
  }

  function write(xmp, value, property) {
    const text = removeProperty(String(xmp || ""), property);
    if (value === null || value === undefined) return text;
    const own = ownDescription(property, value);
    if (/<\/rdf:RDF>/.test(text)) return text.replace(/<\/rdf:RDF>/, own + "</rdf:RDF>");
    return EMPTY_PACKET(own);
  }

  return { read, write };
}
