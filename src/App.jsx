import { useState, useRef, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import JSZip from 'jszip';

// ── pdf.js worker setup ──
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).href;

// ── Constants ──
const BOTTOM_MARGIN_MM = 3;
const ALIGN_RIGHT_MARGIN_PT = 18;
const FONT_SIZE = 7;
const LABEL_TEXT = 'Made In China';
const PREVIEW_TARGET_WIDTH = 280;

const mmToPt = (mm) => mm * 72 / 25.4;

let uidCounter = 0;
const uid = () => `u${++uidCounter}`;

// ── Helpers ──
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Render first page to a data-URL. */
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

/** Process one PDF: add label. */
async function addLabelToPdf(originalBytes) {
  const sourceDoc = await PDFDocument.load(originalBytes.slice(0), { ignoreEncryption: true });
  const pageCount = sourceDoc.getPageCount();
  if (pageCount === 0) throw new Error('PDF 中没有页面');

  const newDoc = await PDFDocument.create();
  const pages = await newDoc.copyPages(sourceDoc, sourceDoc.getPageIndices());
  const font = await newDoc.embedFont(StandardFonts.Helvetica);

  for (const page of pages) {
    newDoc.addPage(page);
    const { width: pageWidth } = page.getSize();
    const textWidth = font.widthOfTextAtSize(LABEL_TEXT, FONT_SIZE);
    const targetRight = pageWidth - ALIGN_RIGHT_MARGIN_PT;
    page.drawText(LABEL_TEXT, {
      x: targetRight - textWidth,
      y: mmToPt(BOTTOM_MARGIN_MM),
      size: FONT_SIZE,
      font,
      color: rgb(0, 0, 0),
    });
  }
  return newDoc.save({ useObjectStreams: false });
}

// ═══════════════════════════════════════════════════════════════════
//  UploadZone  (accepts multiple files)
// ═══════════════════════════════════════════════════════════════════
function UploadZone({ onFiles }) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef(null);

  const add = useCallback((fileList) => {
    const files = Array.from(fileList).filter(f =>
      f.name.toLowerCase().endsWith('.pdf') && f.type !== 'text/plain' && f.size > 0
    );
    if (files.length) onFiles(files);
  }, [onFiles]);

  return (
    <div
      className={`upload-zone${dragOver ? ' drag-over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); add(e.dataTransfer.files); }}
      onClick={() => inputRef.current?.click()}
      role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
    >
      <input ref={inputRef} type="file" accept=".pdf" multiple onChange={(e) => { add(e.target.files); e.target.value = ''; }} hidden />
      <div className="upload-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
      </div>
      <p className="upload-text">点击或拖拽 PDF 文件到此处</p>
      <p className="upload-hint">支持批量选择多个文件，全部处理在浏览器本地完成</p>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  Main App
// ═══════════════════════════════════════════════════════════════════
export default function App() {
  const [uploads, setUploads] = useState([]);
  const [batchProcessing, setBatchProcessing] = useState(false);
  const [error, setError] = useState(null);

  // ── Add files ──
  const handleAddFiles = useCallback(async (files) => {
    setError(null);
    const entries = files.map(f => ({
      id: uid(),
      file: f,
      bytes: null,
      info: null,
      origPreview: null,
      procBytes: null,
      procPreview: null,
      error: null,
      processing: false,
      status: 'pending',    // pending | processing | done | error
    }));
    setUploads(prev => [...prev, ...entries]);

    // Load each in background (parse with pdfjs for info + preview)
    for (const entry of entries) {
      try {
        const ab = await entry.file.arrayBuffer();
        const bytes = new Uint8Array(ab).slice(0);
        const doc = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
        const pageCount = doc.numPages;
        const info = { name: entry.file.name, size: entry.file.size, pageCount };
        const preview = await renderFirstPage(bytes);
        doc.destroy();
        setUploads(prev => prev.map(u =>
          u.id === entry.id ? { ...u, bytes, info, origPreview: preview } : u
        ));
      } catch (err) {
        console.error('Load error:', entry.file.name, err);
        setUploads(prev => prev.map(u =>
          u.id === entry.id ? { ...u, error: '无法读取 PDF，文件可能已损坏或加密', status: 'error' } : u
        ));
      }
    }
  }, []);

  // ── Remove one ──
  const handleRemove = useCallback((id) => {
    setUploads(prev => prev.filter(u => u.id !== id));
  }, []);

  // ── Clear all ──
  const handleClearAll = useCallback(() => {
    setUploads([]);
    setError(null);
    setBatchProcessing(false);
  }, []);

  // ── Process all pending ──
  const handleProcessAll = useCallback(async () => {
    setError(null);
    const pending = uploads.filter(u => u.status === 'pending' && u.bytes);
    if (!pending.length) return;

    setBatchProcessing(true);
    // Mark all as processing
    setUploads(prev => prev.map(u =>
      u.status === 'pending' && u.bytes ? { ...u, processing: true, status: 'processing' } : u
    ));

    for (const entry of pending) {
      try {
        const outBytes = await addLabelToPdf(entry.bytes);
        let preview = null;
        try { preview = await renderFirstPage(outBytes); } catch {}
        setUploads(prev => prev.map(u =>
          u.id === entry.id
            ? { ...u, procBytes: outBytes, procPreview: preview, processing: false, status: 'done' }
            : u
        ));
      } catch (err) {
        console.error('Process error:', entry.file.name, err);
        setUploads(prev => prev.map(u =>
          u.id === entry.id
            ? { ...u, error: '处理失败：' + (err.message || '未知错误'), processing: false, status: 'error' }
            : u
        ));
      }
    }
    setBatchProcessing(false);
  }, [uploads]);

  // ── Download one ──
  const handleDownloadOne = useCallback((entry) => {
    if (!entry.procBytes) return;
    const baseName = entry.file.name.replace(/\.pdf$/i, '');
    const blob = new Blob([entry.procBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${baseName}-made-in-china.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  // ── Download all as ZIP ──
  const handleDownloadAll = useCallback(async () => {
    const done = uploads.filter(u => u.status === 'done' && u.procBytes);
    if (!done.length) return;

    const zip = new JSZip();
    for (const entry of done) {
      const baseName = entry.file.name.replace(/\.pdf$/i, '');
      zip.file(`${baseName}-made-in-china.pdf`, entry.procBytes);
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `made-in-china-labels.zip`;
    a.click();
    URL.revokeObjectURL(url);
  }, [uploads]);

  // ── Derived counts ──
  const pendingCount = uploads.filter(u => u.status === 'pending' && u.bytes).length;
  const doneCount = uploads.filter(u => u.status === 'done').length;
  const hasAnyUpload = uploads.length > 0;
  const hasAnyDone = doneCount > 0;

  // ── Render ──
  return (
    <div className="app">
      <header className="app-header">
        <h1>FBA 标签工具</h1>
        <p className="subtitle">为 PDF 每页右下角添加 Made In China 标识</p>
      </header>

      <main className="app-main">
        {!hasAnyUpload ? (
          <section className="upload-section">
            <UploadZone onFiles={handleAddFiles} />
            {error && <div className="msg msg-error">{error}</div>}
          </section>
        ) : (
          <section className="tool-section">
            {/* ── Upload zone (compact, for adding more) ── */}
            <UploadZone onFiles={handleAddFiles} />

            {/* ── Action bar ── */}
            <div className="action-bar">
              {pendingCount > 0 && (
                <button className="btn btn-primary btn-lg" onClick={handleProcessAll} disabled={batchProcessing}>
                  {batchProcessing ? (
                    <span className="btn-loading"><span className="spinner" />处理中…</span>
                  ) : (
                    `处理全部 (${pendingCount} 个)`
                  )}
                </button>
              )}
              {hasAnyDone && (
                <button className="btn btn-success btn-lg" onClick={handleDownloadAll}>
                  下载全部 ({doneCount} 个)
                </button>
              )}
              <button className="btn btn-ghost" onClick={handleClearAll}>清除全部</button>
            </div>

            {/* ── Error ── */}
            {error && <div className="msg msg-error">{error}</div>}

            {/* ── File list ── */}
            <div className="file-list">
              {uploads.map(entry => (
                <FileCard
                  key={entry.id}
                  entry={entry}
                  onRemove={handleRemove}
                  onDownload={handleDownloadOne}
                />
              ))}
            </div>
          </section>
        )}
      </main>

      <footer className="app-footer">
        <p>所有处理在浏览器本地完成，文件不会上传至任何服务器</p>
        {hasAnyUpload && (
          <p className="footer-pages">
            共 {uploads.length} 个文件，{doneCount} 个已处理
          </p>
        )}
      </footer>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  FileCard (single file row)
// ═══════════════════════════════════════════════════════════════════
function FileCard({ entry, onRemove, onDownload }) {
  const [expanded, setExpanded] = useState(false);
  const { file, info, origPreview, procPreview, status, error: fileErr, processing } = entry;

  const statusIcon = () => {
    if (status === 'error') return <span className="badge badge-error">错误</span>;
    if (status === 'processing') return <span className="badge badge-processing">处理中…</span>;
    if (status === 'done') return <span className="badge badge-done">已完成</span>;
    return <span className="badge badge-pending">待处理</span>;
  };

  return (
    <div className={`file-card${status === 'error' ? ' file-card--error' : ''}`}>
      <div className="file-card-main" onClick={() => setExpanded(!expanded)}>
        <div className="file-card-body">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <div className="file-details">
            <div className="file-name">{file.name}</div>
            <div className="file-meta">
              {info ? `${info.pageCount} 页 · ${formatSize(info.size)}` : '加载中…'}
            </div>
          </div>
        </div>
        <div className="file-card-actions">
          {statusIcon()}
          {status === 'done' && (
            <button className="btn btn-small btn-success" onClick={(e) => { e.stopPropagation(); onDownload(entry); }}>
              下载
            </button>
          )}
          <button className="btn btn-small btn-ghost" onClick={(e) => { e.stopPropagation(); onRemove(entry.id); }}>
            ✕
          </button>
        </div>
      </div>

      {/* Preview (expandable) */}
      {expanded && (origPreview || procPreview) && (
        <div className="file-card-preview">
          <div className="preview-grid">
            {origPreview && (
              <div className="preview-item">
                <span className="preview-label">原文件</span>
                <img src={origPreview} alt="原始" />
              </div>
            )}
            {origPreview && <div className="preview-arrow">→</div>}
            {procPreview ? (
              <div className="preview-item">
                <span className="preview-label">处理后</span>
                <img src={procPreview} alt="处理后" />
              </div>
            ) : (
              status === 'processing' && (
                <div className="preview-item">
                  <span className="preview-label">处理后</span>
                  <div className="preview-placeholder">处理中…</div>
                </div>
              )
            )}
          </div>
        </div>
      )}

      {fileErr && <div className="msg msg-error" style={{ margin: '0.5rem 0 0' }}>{fileErr}</div>}
    </div>
  );
}
