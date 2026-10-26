/** Error carrying an HTTP status + machine-readable code. Pure (no Next imports) so it is usable in tests. */
export class HttpError extends Error {
  status: number;
  code: string;
  headers?: Record<string, string>;
  constructor(status: number, code: string, message: string, headers?: Record<string, string>) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export const notFound = (what = "Not found") => new HttpError(404, "not_found", what);
export const badRequest = (message: string, code = "validation_error") => new HttpError(400, code, message);
