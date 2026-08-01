import './style.css';
import { convertPdf } from './converter';
import { MAX_FILE_BYTES, MAX_PAGES } from './limits';
import {
  NEUTRAL_PALETTE,
  WARM_PALETTE,
  type ConvertMode,
  type NightPalette,
} from './pixels';

const STR = {
  converting: 'جارٍ التحويل…',
  done: 'تم التحويل بنجاح',
  progress: (done: number, total: number) => `الصفحة ${done} من ${total}`,
  stats: (light: number, dark: number) =>
    `صفحات فاتحة محوّلة إلى الوضع الداكن: ${light} — صفحات داكنة مُبقاة داكنة: ${dark}`,
  errors: {
    fileTooLarge: `الملف أكبر من الحد المسموح (أقل من ${Math.floor(MAX_FILE_BYTES / (1024 * 1024))} ميجابايت).`,
    tooManyPages: `الملف يحتوي على ${MAX_PAGES} صفحة أو أكثر. الرجاء اختيار ملف أصغر.`,
    notPdf: 'تعذّر قراءة الملف. تأكد أنه ملف PDF صالح.',
    encrypted: 'الملف محمي بكلمة مرور أو غير مدعوم.',
    noCanvas: 'متصفحك لا يدعم الرسم المطلوب للتحويل.',
    encodeFailed: 'تعذّر معالجة إحدى الصفحات.',
    unknown: 'حدث خطأ غير متوقع أثناء التحويل.',
    cancelled: 'تم إلغاء التحويل.',
  },
};

const dropzone = document.getElementById('dropzone')!;
const fileInput = document.getElementById('file') as HTMLInputElement;
const statusEl = document.getElementById('status')!;
const progressWrap = document.getElementById('progress-wrap')!;
const progressBar = document.getElementById('progress-bar')!;
const progressText = document.getElementById('progress-text')!;
const cancelBtn = document.getElementById('cancel') as HTMLButtonElement;
const resultEl = document.getElementById('result')!;
const doneText = document.getElementById('done-text')!;
const statsEl = document.getElementById('stats')!;
const downloadBtn = document.getElementById('download') as HTMLButtonElement;
const modeInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="mode"]'));
const paletteInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="palette"]'));

let currentAbort: AbortController | null = null;
let resultUrl: string | null = null;

function selectedMode(): ConvertMode {
  return (document.querySelector<HTMLInputElement>('input[name="mode"]:checked')?.value ?? 'bw') === 'bw'
    ? 'bw'
    : 'gray';
}

function selectedPalette(): NightPalette {
  return (document.querySelector<HTMLInputElement>('input[name="palette"]:checked')?.value ?? 'neutral') ===
    'warm'
    ? WARM_PALETTE
    : NEUTRAL_PALETTE;
}

function cancelCurrent(): void {
  currentAbort?.abort();
  currentAbort = null;
}

function resetUi(): void {
  cancelCurrent();
  statusEl.hidden = true;
  resultEl.hidden = true;
  progressWrap.hidden = true;
  progressBar.style.width = '0%';
  progressBar.setAttribute('aria-valuenow', '0');
  progressText.textContent = '';
  dropzone.classList.remove('disabled');
  for (const input of modeInputs) input.disabled = false;
  for (const input of paletteInputs) input.disabled = false;
  if (resultUrl) {
    URL.revokeObjectURL(resultUrl);
    resultUrl = null;
  }
}

function setBusy(busy: boolean): void {
  dropzone.classList.toggle('disabled', busy);
  dropzone.setAttribute('aria-disabled', String(busy));
  dropzone.setAttribute('aria-busy', String(busy));
  for (const input of modeInputs) input.disabled = busy;
  for (const input of paletteInputs) input.disabled = busy;
  progressWrap.hidden = !busy;
}

function showError(message: string): void {
  statusEl.textContent = message;
  statusEl.hidden = false;
}

function pickFile(file: File | undefined): void {
  if (!file) return;
  fileInput.value = '';
  resetUi();
  runConversion(file);
}

function runConversion(file: File): void {
  const abort = new AbortController();
  currentAbort = abort;
  setBusy(true);
  progressText.textContent = STR.converting;

  convertPdf({
    file,
    mode: selectedMode(),
    palette: selectedPalette(),
    onProgress: (done, totalPages) => {
      if (abort.signal.aborted) return;
      const pct = Math.round((done / totalPages) * 100);
      progressBar.style.width = `${pct}%`;
      progressBar.setAttribute('aria-valuenow', String(pct));
      progressText.textContent = STR.progress(done, totalPages);
    },
    shouldCancel: () => abort.signal.aborted,
  })
    .then((result) => {
      if (abort.signal.aborted) return;
      setBusy(false);
      const blob = new Blob([result.bytes], { type: 'application/pdf' });
      if (resultUrl) URL.revokeObjectURL(resultUrl);
      resultUrl = URL.createObjectURL(blob);
      downloadBtn.onclick = () => {
        const a = document.createElement('a');
        a.href = resultUrl!;
        a.download = result.fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
      };
      doneText.textContent = STR.done;
      statsEl.textContent = STR.stats(result.lightPages, result.darkPages);
      resultEl.hidden = false;
    })
    .catch((err) => {
      if (abort.signal.aborted) {
        if (currentAbort === abort) resetUi();
        return;
      }
      setBusy(false);
      const code = err?.code ?? 'unknown';
      const message = STR.errors[code as keyof typeof STR.errors] ?? STR.errors.unknown;
      showError(message);
    })
    .finally(() => {
      if (currentAbort === abort) currentAbort = null;
    });
}

dropzone.addEventListener('click', () => {
  if (dropzone.classList.contains('disabled')) return;
  fileInput.click();
});

dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    if (!dropzone.classList.contains('disabled')) fileInput.click();
  }
});

fileInput.addEventListener('change', () => pickFile(fileInput.files?.[0]));

for (const evt of ['dragenter', 'dragover'] as const) {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
}
for (const evt of ['dragleave', 'drop'] as const) {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
  });
}

dropzone.addEventListener('drop', (e) => {
  if (dropzone.classList.contains('disabled')) return;
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  if (file.size >= MAX_FILE_BYTES) {
    resetUi();
    showError(STR.errors.fileTooLarge);
    return;
  }
  pickFile(file);
});

cancelBtn.addEventListener('click', () => {
  currentAbort?.abort();
  progressText.textContent = '…';
});

window.addEventListener('dragenter', (e) => e.preventDefault());
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

window.addEventListener('pagehide', () => {
  if (resultUrl) URL.revokeObjectURL(resultUrl);
});

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
