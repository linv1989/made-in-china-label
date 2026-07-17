import { useState, useRef, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

// ── pdf.js worker setup (Vite resolves & copies the worker file at build time) ──
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).href;

// ── Constants ──
const BOTTOM_MARGIN_MM = 3;       // text baseline from page bottom edge
const ALIGN_RIGHT_MARGIN_PT = 18; // fixed right margin (~product title position for this label)
const FONT_SIZE = 7;
const LABEL_TEXT = 'Made In China';
const PREVIEW_TARGET_WIDTH = 320; // px

const mmToPt = (mm) => mm * 72 / 25.4;

// ── Helpers ──
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Render the first page of a PDF (bytes → Uint8Array) to a data-URL at a given display width. */
async function renderFirstPage(bytes, targetWidth = PREVIEW_TARGET_WIDTH) {
  const doc = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
  try {
    const page = await doc.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    const scale = targetWidth / vp.width;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas.toDataURL();
  } finally {
    doc.destroy();
  }
}

/** Use pdf-lib to add the MADE IN CHINA label to every page.
 *
 *  Strategy: create a fresh PDF, copy all pages from the source into it,
 *  then draw the label.  This avoids issues with certain PDF structures
 *  (object streams, XFA, etc.) that can break round-trip preservation. */
async function addLabelToPdf(originalBytes) {
  // Load the source document to read its pages
  const sourceDoc = await PDFDocument.load(originalBytes.slice(0), {
    ignoreEncryption: true,
  });

  const pageCount = sourceDoc.getPageCount();
  if (pageCount === 0) {
    throw new Error('PDF 中没有页面');
  }

  // Create a fresh document and copy all pages
  const newDoc = await PDFDocument.create();
  const pageIndices = sourceDoc.getPageIndices();
  const copiedPages = await newDoc.copyPages(sourceDoc, pageIndices);

  const font = await newDoc.embedFont(StandardFonts.Helvetica);

  for (let i = 0; i < copiedPages.length; i++) {
    const page = copiedPages[i];
    newDoc.addPage(page);

    const { width: pageWidth } = page.getSize();
    const textWidth = font.widthOfTextAtSize(LABEL_TEXT, FONT_SIZE);
    // Align text's right edge to the fixed right margin (matches product title
    // position for common FBA label sizes; falls back near right edge on other sizes)
    const targetRight = pageWidth - ALIGN_RIGHT_MARGIN_PT;
    const x = targetRight - textWidth;
    const y = mmToPt(BOTTOM_MARGIN_MM);

    page.drawText(LABEL_TEXT, {
      x,
      y,
      size: FONT_SIZE,
      font,
      color: rgb(0, 0, 0),
    });
  }

  // Disable object streams for maximum viewer compatibility
  return newDoc.save({ useObjectStreams: false });
}

// ── Sub-components (kept in one file for this focused tool) ──

function UploadZone({ onFile }) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef(null);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) onFile(f);
  }, [onFile]);

  const handleChange = useCallback((e) => {
    const f = e.target.files[0];
    if (f) onFile(f);
    e.target.value = ''; // allow re-select same file
  }, [onFile]);

  return (
    <div
      className={`upload-zone${dragOver ? ' drag-over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
    >
      <input ref={inputRef} type="file" accept=".pdf" onChange={handleChange} hidden />
      <div className="upload-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
      </div>
      <p className="upload-text">点击或拖拽 PDF 文件到此处</p>
      <p className="upload-hint">仅支持 .pdf 格式，文件不上传服务器</p>
    </div>
  );
}

// ── Main App ──

export default function App() {
  const [file, setFile] = useState(null);
  const [fileBytes, setFileBytes] = useState(null);
  const [fileInfo, setFileInfo] = useState(null);    // { name, size, pageCount }
  const [origPreview, setOrigPreview] = useState(null);
  const [procPreview, setProcPreview] = useState(null);
  const [procBytes, setProcBytes] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState(null);

  const reset = useCallback(() => {
    setFile(null);
    setFileBytes(null);
    setFileInfo(null);
    setOrigPreview(null);
    setProcPreview(null);
    setProcBytes(null);
    setProcessing(false);
    setError(null);
  }, []);

  /** Validate and load a dropped/selected file. */
  const handleFile = useCallback(async (f) => {
    setError(null);
    setProcBytes(null);
    setProcPreview(null);

    if (!f.name.toLowerCase().endsWith('.pdf') || f.type === 'text/plain') {
      setError('请选择一个有效的 PDF 文件');
      return;
    }
    if (f.size === 0) {
      setError('文件为空，请选择有效的 PDF 文件');
      return;
    }

    try {
      const bytes = await f.arrayBuffer();
      // Store an independent copy of the bytes so no other consumer
      // (pdfjs worker, etc.) can transfer/detach the underlying buffer.
      const uint8 = new Uint8Array(bytes);
      const copy = uint8.slice(0);
      setFileBytes(copy);

      // MUST load pdf first and get all metadata BEFORE setting file,
      // otherwise React renders the tool section with null fileInfo → crash
      const doc = await pdfjsLib.getDocument({ data: copy.slice(0) }).promise;
      const pageCount = doc.numPages;
      const info = { name: f.name, size: f.size, pageCount };
      setFileInfo(info);

      const previewUrl = await renderFirstPage(copy);
      setOrigPreview(previewUrl);
      doc.destroy();
      setFile(f); // <-- set file LAST, after all data is ready
    } catch (err) {
      console.error('Load error:', err);
      setError('无法读取 PDF 文件，文件可能已损坏或加密');
      // reset everything (setFile was never called if error was before it)
      setFile(null);
      setFileBytes(null);
      setFileInfo(null);
      setOrigPreview(null);
    }
  }, []);

  /** Process the PDF: add label to every page. */
  const handleGenerate = useCallback(async () => {
    if (!fileBytes) return;
    setProcessing(true);
    setError(null);

    try {
      const outBytes = await addLabelToPdf(fileBytes);
      setProcBytes(outBytes);

      const previewUrl = await renderFirstPage(outBytes);
      setProcPreview(previewUrl);
    } catch (err) {
      console.error('Processing error:', err);
      setError('处理 PDF 时出错' + (err.message ? '：' + err.message : '，请确认文件未加密且格式正确'));
    } finally {
      setProcessing(false);
    }
  }, [fileBytes]);

  /** Download the processed PDF. */
  const handleDownload = useCallback(() => {
    if (!procBytes) return;
    const baseName = file.name.replace(/\.pdf$/i, '');
    const blob = new Blob([procBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${baseName}-made-in-china.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  }, [procBytes, file]);

  return (
    <div className="app">
      <header className="app-header">
        <h1>FBA 标签工具</h1>
        <p className="subtitle">为 PDF 每页底部添加「MADE IN CHINA」标识</p>
      </header>

      <main className="app-main">
        {!file ? (
          <section className="upload-section">
            <UploadZone onFile={handleFile} />
            {error && <div className="msg msg-error">{error}</div>}
          </section>
        ) : (
          <section className="tool-section">
            {/* ── File info ── */}
            <div className="card file-card">
              <div className="file-card-body">
                <span className="file-icon">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="16" y1="13" x2="8" y2="13" />
                    <line x1="16" y1="17" x2="8" y2="17" />
                  </svg>
                </span>
                <div className="file-details">
                <div className="file-name">{fileInfo?.name}</div>
                  <div className="file-meta">{fileInfo?.pageCount ?? '?'} 页 · {formatSize(fileInfo?.size ?? 0)}</div>
                </div>
              </div>
              <button className="btn btn-ghost" onClick={reset}>清除</button>
            </div>

            {/* ── Rules ── */}
            <div className="card rules-card">
              <h3>添加规则</h3>
              <ul>
                <li>文字：<strong>Made In China</strong>（区分大小写）</li>
                <li>位置：每页右下角，与产品标题右对齐，距下边缘 3 mm</li>
                <li>字体：Helvetica（<strong>不加粗</strong>），7 pt，黑色</li>
                <li>范围：PDF 全部页面</li>
                <li>其他：保留原 PDF 所有内容与页面尺寸</li>
              </ul>
            </div>

            {/* ── Error ── */}
            {error && <div className="msg msg-error">{error}</div>}

            {/* ── Preview ── */}
            <div className="card preview-card">
              <h3>预览（第 1 页）</h3>
              <div className="preview-grid">
                <div className="preview-item">
                  <span className="preview-label">原文件</span>
                  {origPreview ? (
                    <img src={origPreview} alt="原始 PDF 第 1 页" />
                  ) : (
                    <div className="preview-placeholder">加载中…</div>
                  )}
                </div>
                <div className="preview-arrow">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="5" y1="12" x2="19" y2="12" />
                    <polyline points="12 5 19 12 12 19" />
                  </svg>
                </div>
                <div className="preview-item">
                  <span className="preview-label">处理后</span>
                  {procPreview ? (
                    <img src={procPreview} alt="处理后 PDF 第 1 页" />
                  ) : (
                    <div className="preview-placeholder">
                      {processing ? '处理中…' : '等待生成'}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* ── Action ── */}
            <div className="action-bar">
              {!procBytes ? (
                <button
                  className="btn btn-primary btn-lg"
                  onClick={handleGenerate}
                  disabled={processing}
                >
                  {processing ? (
                    <span className="btn-loading">
                      <span className="spinner" />
                      处理中…
                    </span>
                  ) : (
                    '生成标签 PDF'
                  )}
                </button>
              ) : (
                <button className="btn btn-success btn-lg" onClick={handleDownload}>
                  下载 PDF
                </button>
              )}
            </div>
          </section>
        )}
      </main>

      <footer className="app-footer">
        <p>所有处理在浏览器本地完成，文件不会上传至任何服务器</p>
        <p className="footer-pages">
          {fileInfo && (
            <>
              共 {fileInfo.pageCount} 页
              {procBytes && (
                <>
                  · 已处理全部页面
                  · 输出 {formatSize(procBytes.length)}
                  {fileBytes && `（原 ${formatSize(fileBytes.length)}）`}
                </>
              )}
            </>
          )}
        </p>
      </footer>
    </div>
  );
}
