// Hand-made SVG strings for the allow-list pass (src/lib/svg-allow.ts). Each
// one is fed to the pass directly; no Pele is involved. The same list runs in
// bun (tests/svg-allow.test.ts, with tests/helpers/mini-xml.ts) and in the
// browser with the real DOMParser (wave/n5-report.md).
//
// `out` is the exact output expected, or null for "show the source as code".
// `undefined` means only the generic checks apply (the parsers may differ).
const NS = 'xmlns="http://www.w3.org/2000/svg"'
const R = '<rect width="1" height="1"></rect>'
const OPEN = `<svg xmlns="http://www.w3.org/2000/svg">`

export const HOSTILE: { name: string; svg: string; out?: string | null }[] = [
  { name: "a script element", svg: `<svg ${NS}>${R}<script>alert(1)</script></svg>`, out: `${OPEN}${R}</svg>` },
  {
    name: "a foreignObject with an HTML div",
    svg: `<svg ${NS}>${R}<foreignObject width="9" height="9"><div xmlns="http://www.w3.org/1999/xhtml" onclick="alert(1)">x<img src="x" onerror="alert(1)"/></div></foreignObject></svg>`,
    out: `${OPEN}${R}</svg>`,
  },
  { name: "a link around text", svg: `<svg ${NS}>${R}<a href="javascript:alert(1)"><text>x</text></a></svg>`, out: `${OPEN}${R}</svg>` },
  { name: "an image", svg: `<svg ${NS}>${R}<image href="https://example.invalid/p.png" width="9" height="9"/></svg>`, out: `${OPEN}${R}</svg>` },
  {
    name: "use with xlink:href",
    svg: `<svg ${NS} xmlns:xlink="http://www.w3.org/1999/xlink">${R}<use xlink:href="#a"/><use href="#a"/></svg>`,
    out: `${OPEN}${R}</svg>`,
  },
  {
    name: "a style element",
    svg: `<svg ${NS}><style>@import url(https://example.invalid/x.css); rect { fill: red }</style>${R}</svg>`,
    out: `${OPEN}${R}</svg>`,
  },
  {
    name: "animate and set",
    svg: `<svg ${NS}><rect width="1" height="1"><set attributeName="onmouseover" to="alert(1)"/><animate attributeName="href" values="javascript:alert(1)"/></rect></svg>`,
    out: `${OPEN}${R}</svg>`,
  },
  { name: "event attributes", svg: `<svg ${NS} onload="alert(1)"><rect width="1" height="1" onclick="alert(1)" ONMOUSEOVER="x"/></svg>`, out: `${OPEN}${R}</svg>` },
  { name: "href on an allowed element", svg: `<svg ${NS}><rect width="1" height="1" href="javascript:alert(1)"/></svg>`, out: `${OPEN}${R}</svg>` },
  {
    name: "url() in attributes",
    svg: `<svg ${NS}><rect width="1" height="1" fill="url(https://example.invalid/a)" stroke="url(#m1)" transform="url(x)"/></svg>`,
    // A paint becomes the line token; any other attribute with url() goes.
    out: `${OPEN}<rect width="1" height="1" fill="var(--pele-line)" stroke="url(#m1)"></rect></svg>`,
  },
  {
    name: "a same-document gradient paint (Sankey) and a foreign fallback",
    svg: `<svg ${NS}><path d="M0,0L1,1" fill="url(#m1-g0) var(--pele-series-1,#4c78a8)"/><path d="M0,0L1,1" fill="url(#m1-g0) url(https://example.invalid/a)"/></svg>`,
    out: `${OPEN}<path d="M0,0L1,1" fill="url(#m1-g0) var(--pele-series-1)"></path><path d="M0,0L1,1" fill="var(--pele-line)"></path></svg>`,
  },
  {
    name: "url() and other properties in a style",
    svg: `<svg ${NS}><rect width="1" height="1" style="fill:url(https://example.invalid/a);background:url(x);position:fixed;stroke-width:2;behavior:url(x.htc)"/></svg>`,
    // A style that holds a foreign url() is dropped whole.
    out: `${OPEN}${R}</svg>`,
  },
  {
    name: "an element in another namespace",
    svg: `<svg ${NS}><h:div xmlns:h="http://www.w3.org/1999/xhtml">x</h:div><rect xmlns="http://example.invalid/ns" width="1" height="1"/>${R}</svg>`,
    out: `${OPEN}${R}</svg>`,
  },
  { name: "an svg root with no namespace", svg: `<svg>${R}</svg>`, out: null },
  { name: "a root that is not svg", svg: `<g ${NS}>${R}</g>`, out: null },
  { name: "a parse error", svg: `<svg ${NS}><rect></svg>`, out: null },
  { name: "nothing drawable", svg: `<svg ${NS}><g><title>t</title></g></svg>`, out: null },
  { name: "empty", svg: "", out: null },
  {
    name: "class names other than Pele's",
    svg: `<svg ${NS}><rect width="1" height="1" class="pele-node fixed inset-0 z-50"/></svg>`,
    // No class is written at all.
    out: `${OPEN}${R}</svg>`,
  },
  {
    name: "custom properties and colours in a style",
    svg: `<svg ${NS} style="--pele-series-1:#ff0000;--_bg:var(--pele-bg,#fff);--_x:red;--_y:var(--destructive);color:var(--_fg)">${R}</svg>`,
    // No custom property is written. --_fg is not defined by the root, so
    // color:var(--_fg) has no frame name and goes too.
    out: `${OPEN}${R}</svg>`,
  },
  {
    name: "fixed colours and app tokens",
    svg: `<svg ${NS}><rect width="1" height="1" fill="#ff0000" stroke="var(--destructive)" style="fill:green;stroke:var(--_l)"/></svg>`,
    out: `${OPEN}<rect width="1" height="1" fill="var(--pele-line)" stroke="var(--pele-line)"></rect></svg>`,
  },
  // Review N5-2 M1: a Pele-looking variable the frame does not map would fall
  // back to its fixed colour. Only mapped names are written, never a fallback.
  {
    name: "an unmapped Pele variable with a colour fallback",
    svg: `<svg ${NS}><rect width="100" height="30" fill="var(--pele-unmapped,red)"/></svg>`,
    out: `${OPEN}<rect width="100" height="30" fill="var(--pele-line)"></rect></svg>`,
  },
  {
    name: "an alias to an unmapped variable",
    svg: `<svg ${NS} style="--_s:var(--pele-unmapped,red);--_b:var(--pele-border,red)"><rect width="1" height="1" fill="var(--_s)" stroke="var(--_b)" style="fill:var(--_s);rx:var(--_s)"/></svg>`,
    out: `${OPEN}<rect width="1" height="1" fill="var(--pele-line)" stroke="var(--pele-border)"></rect></svg>`,
  },
  {
    name: "a gradient paint whose fallback is unmapped or fixed",
    svg: `<svg ${NS}><path d="M0,0L1,1" fill="url(#g) var(--pele-unmapped,red)"/><path d="M0,0L1,1" fill="url(#g) red"/><path d="M0,0L1,1" stroke="url(#g) var(--pele-series-2,#00ff00)"/></svg>`,
    out: `${OPEN}<path d="M0,0L1,1" fill="var(--pele-line)"></path><path d="M0,0L1,1" fill="var(--pele-line)"></path><path d="M0,0L1,1" stroke="url(#g) var(--pele-series-2)"></path></svg>`,
  },
  {
    name: "a font shorthand that names a font",
    svg: `<svg ${NS}><text style="font:30px Papyrus;font-weight:bold">x</text><text style="font:italic 700 30px/2 Papyrus, serif">y</text></svg>`,
    out: `${OPEN}<text style="font-size:30px;font-weight:bold">x</text><text>y</text></svg>`,
  },
  {
    name: "an apostrophe in a value and in text",
    svg: `<svg ${NS}><text data-id="it's">it's</text></svg>`,
    out: `${OPEN}<text data-id="it&#39;s">it&#39;s</text></svg>`,
  },
  {
    name: "markup in text as entities",
    svg: `<svg ${NS}><text x="1">&lt;script&gt;alert(1)&lt;/script&gt; &amp; "q"</text></svg>`,
    out: `${OPEN}<text x="1">&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;</text></svg>`,
  },
  {
    name: "markup in CDATA",
    svg: `<svg ${NS}><text><![CDATA[<script>alert(1)</script>]]></text></svg>`,
    out: `${OPEN}<text>&lt;script&gt;alert(1)&lt;/script&gt;</text></svg>`,
  },
  {
    name: "a comment and a stylesheet instruction",
    svg: `<?xml-stylesheet href="https://example.invalid/x.css"?><svg ${NS}><!-- <script>x</script> -->${R}</svg>`,
    out: `${OPEN}${R}</svg>`,
  },
  // The test reader refuses a DOCTYPE (null); a browser may expand the entity
  // as text. Either way no tag comes out of it.
  { name: "a DOCTYPE with an entity", svg: `<!DOCTYPE svg [<!ENTITY x "<script>alert(1)</script>">]><svg ${NS}><text>&x;</text>${R}</svg>` },
  {
    name: "an attribute value that tries to close its quotes",
    svg: `<svg ${NS}><rect width="1" height="1" data-id='a" onclick="alert(1)'/></svg>`,
    out: `${OPEN}${R}</svg>`,
  },
  {
    name: "a quote inside an attribute value is escaped",
    svg: `<svg ${NS}><rect width="1" height="1" data-id='a"b'/></svg>`,
    out: `${OPEN}<rect width="1" height="1" data-id="a&quot;b"></rect></svg>`,
  },
  {
    name: "other xml: attributes",
    svg: `<svg ${NS}><text xml:base="https://example.invalid/" xml:space="preserve" xml:lang="en">x</text></svg>`,
    out: `${OPEN}<text xml:space="preserve">x</text></svg>`,
  },
  { name: "names in another case", svg: `<svg ${NS}><SCRIPT>alert(1)</SCRIPT><Rect width="1" height="1"/>${R}</svg>`, out: `${OPEN}${R}</svg>` },
  {
    name: "a font chosen by the source",
    svg: `<svg ${NS}><text font-family="Comic Sans" style="font-family:Papyrus;font-weight:bold">x</text></svg>`,
    out: `${OPEN}<text style="font-weight:bold">x</text></svg>`,
  },
]
