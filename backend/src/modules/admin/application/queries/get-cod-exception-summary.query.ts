import { Inject, Injectable } from '@nestjs/common';
import {
  COD_EXCEPTION_SUMMARY_READ_PORT,
  CodExceptionSummary,
  ICodExceptionSummaryReadPort,
} from '../../../delivery/application/ports/inbound/cod-exception-summary-read.port';

/**
 * `GET /admin/operations/cod/summary` (module-16 Work 39): Module 08's COD exception and aging
 * counts, through `COD_EXCEPTION_SUMMARY_READ_PORT`. Every definition is Module 08's; nothing is
 * computed here. Read-only; not audited.
 */
@Injectable()
export class GetCodExceptionSummaryQuery {
  constructor(@Inject(COD_EXCEPTION_SUMMARY_READ_PORT) private readonly cod: ICodExceptionSummaryReadPort) {}

  execute(): Promise<CodExceptionSummary> {
    return this.cod.summarizeExceptions();
  }
}
