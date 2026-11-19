import { placeImage } from './placement.mjs';

// Independent original image-send preparation factory. It composes the existing
// ImageStore (staging + full pixel decode) and placement.mjs (destination + byte
// verification) into a single buildImageElement that NativeBridge can inject.
// Accepts base64:// inline bytes (staged directly) and https:// CDN URLs (bounded
// download into the store first). It never resolves paths itself, never calls
// sendMsg, and fails closed: a missing rich-media path method, missing copy
// interface, out-of-area destination, byte mismatch, or non-https source aborts
// BEFORE any element is handed back. Real QQ transfer still needs a verified
// wrapper + an online session.
export class NativeImagePlacementError extends Error {
  constructor(code, message) { super(message); this.name = 'NativeImagePlacementError'; this.code = code; }
}

function fail(code, message) { throw new NativeImagePlacementError(code, message); }

// Only public QQ CDN hosts a sticker/image URL may point at. No private/loopback
// addresses, no credentials, no arbitrary host. Mirrors the App's SSRF stance.
const ALLOWED_IMAGE_HOSTS = ['gchat.qpic.cn', 'multimedia.nt.qq.com.cn', 'c2cpicdw.qpic.cn', 'gchatpic_new.qpic.cn'];

// NapCat's PicType enum, authoritative for the send path
// (napcat.mjs createValidSendPicElement -> picType: await Aye(n), where Aye maps the
// file extension: gif=NEWPIC_GIF=2000, png=NEWPIC_PNG=1001, webp=NEWPIC_WEBP=1002,
// jpeg/jpg=NEWPIC_JPEG=1000, anything else falls back to NEWPIC_JPEG). Measured
// 2026-11-16: we used to hardcode 1000, i.e. every animated GIF sticker was announced
// to QQ as a JPEG still, and picWidth/picHeight were 0 so the bubble had no size.
const PIC_TYPE_BY_FORMAT = Object.freeze({ gif: 2000, png: 1001, webp: 1002, jpeg: 1000 });
const PIC_TYPE_DEFAULT = 1000;
function httpsImageUrl(value) {
  if (typeof value !== 'string' || value.length > 8192 || !value.startsWith('https://')) return undefined;
  let parsed;
  try { parsed = new URL(value); } catch { return undefined; }
  if (parsed.username || parsed.password || parsed.port || parsed.hash) return undefined;
  if (!ALLOWED_IMAGE_HOSTS.some(host => parsed.hostname === host || parsed.hostname.endsWith('.' + host))) return undefined;
  return value;
}

/**
 * @param {object} options
 * @param {{ stageOneBotFile(string): Promise<{token:string,md5:string,bytes:number,fileName:string}> }} options.store
 * @param {string} options.root  absolute placement root (must be an existing physical directory)
 * @param {(source:string, destination:string) => Promise<void>|void} options.copy  native wrapper copyFile binding
 * @param {(url:string, signal?:AbortSignal) => Promise<Uint8Array>} [options.download]  bounded https downloader (defaults to global fetch)
 * @param {number} [options.maxDownloadBytes=10*1024*1024]
 */
export function createNativeImagePlacement({ store, root, copy, download, maxDownloadBytes = 10 * 1024 * 1024 }) {
  if (!store || typeof store.stageOneBotFile !== 'function') fail('STORE_REQUIRED', 'An ImageStore staging backend is required');
  if (typeof root !== 'string' || !root) fail('INVALID_ROOT', 'A placement root is required');
  if (typeof copy !== 'function') fail('COPY_REQUIRED', 'A native copyFile binding is required');
  if (!Number.isSafeInteger(maxDownloadBytes) || maxDownloadBytes < 1 || maxDownloadBytes > 64 * 1024 * 1024) fail('INVALID_LIMIT', 'maxDownloadBytes is out of range');
  const fetchBytes = async (url) => {
    if (download) return download(url);
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) fail('DOWNLOAD_FAILED', `Image download returned HTTP ${response.status}`);
    const length = Number(response.headers.get('content-length') || '0');
    if (length > maxDownloadBytes) fail('LIMIT_EXCEEDED', 'Image download exceeds the size bound');
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.length > maxDownloadBytes) fail('LIMIT_EXCEEDED', 'Image download exceeds the size bound');
    return buffer;
  };
  return Object.freeze({
    /**
     * Stage an inline base64 image (or download a bounded https CDN image) and
     * place it at the native-computed target, returning the elementType=2
     * envelope. `msg` supplies the exact getRichMediaFilePathForGuild method so
     * the destination comes from the real SDK, never from a guessed path.
     */
    async buildImageElement(file, { msg, subType = 0, summary = '' } = {}) {
      // A base64 image is hundreds of KB of characters; the old 8192 cap was meant
      // for URLs and rejected every inline image outright (measured 2026-11-16: a
      // sticker send ended as IMAGE_PREPARE_FAILED -> HTTP 404 on the App side).
      // Bound the URL form by characters and the inline form by DECODED bytes.
      const inlineSource = typeof file === 'string' && file.startsWith('base64://');
      const maxChars = inlineSource ? Math.ceil(maxDownloadBytes / 3) * 4 + 64 : 8192;
      if (typeof file !== 'string' || file.length === 0 || file.length > maxChars)
        fail('UNSUPPORTED_SOURCE', inlineSource
          ? 'Inline image exceeds the size bound'
          : 'Image file must be base64:// or an https CDN URL');
      if (!msg || typeof msg.getRichMediaFilePathForGuild !== 'function')
        fail('MEDIA_PATH_UNAVAILABLE', 'Native rich-media path method is unavailable');
      const picSubType = Number.isInteger(subType) && subType >= 0 && subType <= 255 ? subType : 0;
      const safeSummary = typeof summary === 'string' && summary.length <= 256 ? summary : '';
      let asset;
      if (file.startsWith('base64://')) {
        asset = await store.stageOneBotFile(file);
      } else {
        const url = httpsImageUrl(file);
        if (url === undefined) fail('UNSUPPORTED_SOURCE', 'Image file must be base64:// or a public QQ CDN https URL');
        const bytes = await fetchBytes(url);
        asset = await store.stage(bytes, { filename: undefined });
      }
      const placed = await placeImage({
        store, token: asset.token, root,
        elementSubType: picSubType,
        resolveDestination: spec => msg.getRichMediaFilePathForGuild(spec),
        copy,
      });
      const format = typeof asset.format === 'string' ? asset.format.toLowerCase() : '';
      const picType = PIC_TYPE_BY_FORMAT[format] ?? PIC_TYPE_DEFAULT;
      const picWidth = Number.isSafeInteger(asset.width) && asset.width > 0 ? asset.width : 0;
      const picHeight = Number.isSafeInteger(asset.height) && asset.height > 0 ? asset.height : 0;
      return { elementType: 2, elementId: '', picElement: {
        md5HexStr: asset.md5, fileSize: String(asset.bytes), fileName: asset.fileName,
        sourcePath: placed.nativePath, picWidth, picHeight, original: true,
        picType, picSubType, fileUuid: '', fileSubId: '', summary: safeSummary,
        thumbFileSize: 0,
      } };
    },
  });
}
