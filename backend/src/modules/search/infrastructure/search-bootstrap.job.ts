import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { AppConfigService } from '../../../shared/config/app-config.service';
import { AppLogger } from '../../../shared/logging/app-logger.service';
import { SearchProjectorService } from '../application/search-projector.service';

/**
 * Work 98: an empty search index (a new deployment, or the first start after this Work) is built
 * from the source modules once, in the background, so the existing catalogue and stock are
 * searchable without a manual step. Off in tests and CLI processes, like every background job.
 * `npm run search:reindex` rebuilds on demand.
 */
@Injectable()
export class SearchBootstrapJob implements OnApplicationBootstrap {
  private readonly logger = new AppLogger();

  constructor(
    private readonly projector: SearchProjectorService,
    private readonly appConfig: AppConfigService,
  ) {
    this.logger.setContext(SearchBootstrapJob.name);
  }

  onApplicationBootstrap(): void {
    if (!this.appConfig.runsBackgroundJobs) return;
    void this.buildIfEmpty();
  }

  private async buildIfEmpty(): Promise<void> {
    try {
      if (!(await this.projector.isEmpty())) return;
      const report = await this.projector.reindexAll();
      this.logger.log({ message: 'Search index built from the catalogue and pharmacy stock', ...report });
    } catch (err) {
      this.logger.error({ message: 'Building the search index failed; run npm run search:reindex', error: err instanceof Error ? err.message : String(err) });
    }
  }
}
