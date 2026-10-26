export class CspError extends Error {}
/** The value of the Content-Security-Policy header for a parsed media-config.json. Throws CspError for a bad origin. */
export function buildCsp(config: unknown): string;
/** The nginx include file that sets the header. */
export function nginxInclude(csp: string): string;
/** The include file for the text of a media-config.json; `name` is the file's name, for messages. */
export function generate(configText: string, name: string): string;
export interface CspIo {
  readFile(path: string): string;
  writeFile(path: string, text: string): void;
  error(message: string): void;
}
/** The command line, `<media-config.json> <output file>`. Returns the exit code. */
export function run(args: string[], io: CspIo): number;
