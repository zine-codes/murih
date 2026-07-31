import { describe, expect, it } from 'vitest';
import { AppError, darkFileName } from '../src/converter';

describe('darkFileName', () => {
  it('appends -darkmode for a .pdf name', () => {
    expect(darkFileName('report.pdf')).toBe('report-darkmode.pdf');
  });

  it('is case-insensitive on the extension', () => {
    expect(darkFileName('Report.PDF')).toBe('Report-darkmode.pdf');
  });

  it('works for names without the .pdf extension', () => {
    expect(darkFileName('notes')).toBe('notes-darkmode.pdf');
  });

  it('does not corrupt names containing .pdf mid-string', () => {
    expect(darkFileName('my.pdf.backup.pdf')).toBe('my.pdf.backup-darkmode.pdf');
  });
});

describe('AppError', () => {
  it('carries the code and a default message', () => {
    const err = new AppError('fileTooLarge');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('fileTooLarge');
    expect(err.message).toBe('fileTooLarge');
    expect(err.name).toBe('AppError');
  });

  it('uses the detail string as the message', () => {
    const err = new AppError('unknown', 'something broke');
    expect(err.message).toBe('something broke');
  });

  it('preserves an original Error message and cause context', () => {
    const cause = new Error('root cause');
    const err = new AppError('unknown', cause);
    expect(err.message).toBe('root cause');
    expect(err.code).toBe('unknown');
  });

  it('stringifies non-string, non-Error detail', () => {
    const err = new AppError('unknown', 42);
    expect(err.message).toBe('42');
  });
});
