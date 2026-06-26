import chalk from 'chalk';
import type { FormatterOptions } from '../types/index.js';

export class Formatter {
  private readonly options: Required<FormatterOptions>;

  constructor(options: FormatterOptions) {
    this.options = {
      json: options.json ?? false,
      quiet: options.quiet ?? false,
      verbose: options.verbose ?? false,
    };
  }

  /** Print a success message (green). Suppressed in quiet mode. */
  success(message: string): void {
    if (this.options.quiet) return;
    console.log(chalk.green(message));
  }

  /** Print an error message (red) to stderr. */
  error(message: string): void {
    console.error(chalk.red(message));
  }

  /** Print a warning message (yellow). Suppressed in quiet mode. */
  warn(message: string): void {
    if (this.options.quiet) return;
    console.warn(chalk.yellow(message));
  }

  /** Print an informational message. Suppressed in quiet mode. */
  info(message: string): void {
    if (this.options.quiet) return;
    console.log(message);
  }

  /** Print a verbose/debug message. Only shown with --verbose. */
  verbose(message: string): void {
    if (!this.options.verbose) return;
    console.log(chalk.gray(message));
  }

  /** Print a formatted table. Suppressed in quiet mode. */
  table(headers: string[], rows: (string | number)[][]): void {
    if (this.options.quiet) return;

    // Compute column widths from headers and data
    const colWidths = headers.map((h, i) => {
      let max = h.length;
      for (const row of rows) {
        const cellLen = String(row[i] ?? '').length;
        if (cellLen > max) max = cellLen;
      }
      return max;
    });

    // Print header row
    const headerLine = headers
      .map((h, i) => h.padEnd(colWidths[i]))
      .join('  ');
    console.log(headerLine);

    // Print separator
    const separator = colWidths.map((w) => '-'.repeat(w)).join('  ');
    console.log(separator);

    // Print data rows
    for (const row of rows) {
      const line = row
        .map((cell, i) => String(cell ?? '').padEnd(colWidths[i]))
        .join('  ');
      console.log(line);
    }
  }

  /** Print data as formatted JSON to stdout. */
  json(data: unknown): void {
    console.log(JSON.stringify(data, null, 2));
  }

  /** Print raw text to stdout (not suppressed by quiet). */
  raw(text: string): void {
    console.log(text);
  }

  /** Whether JSON output mode is enabled. */
  get isJson(): boolean {
    return this.options.json;
  }

  /** Whether quiet mode is enabled. */
  get isQuiet(): boolean {
    return this.options.quiet;
  }

  /** Whether verbose mode is enabled. */
  get isVerbose(): boolean {
    return this.options.verbose;
  }
}

/**
 * Create a formatter instance from CLI options.
 */
export function createFormatter(options: FormatterOptions): Formatter {
  return new Formatter(options);
}
