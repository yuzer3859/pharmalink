import { Inject, Injectable } from '@nestjs/common';
import { PlatformConfigResolver } from '../../../../shared/config/platform-config.resolver';
import { FeatureFlagProps } from '../../domain/entities/feature-flag.entity';
import {
  FEATURE_FLAG_REPOSITORY,
  IFeatureFlagRepository,
} from '../../domain/repositories/feature-flag.repository';

export interface FeatureFlagView {
  key: string;
  /** The state actually in force — the stored row's, since a row exists for every flag listed. */
  enabled: boolean;
  description: string | null;
  updatedBy: string | null;
  updatedAt: Date;
}

/**
 * The feature-flag read surface (module-16 §9.4's `GET /admin/feature-flags`).
 *
 * ## Why this lists the table and not a catalogue
 *
 * The opposite of `GetConfigQuery`, and deliberately so. Configuration keys are declared by the
 * code that reads them, so a catalogue can enumerate them; flag keys are not — a flag is named by
 * whoever introduces the capability, and there is no registry of them to enumerate. Inventing one
 * would mean maintaining a list that goes stale the moment a feature ships with a new flag name.
 *
 * The consequence is worth stating plainly: **a flag that has never been administered does not
 * appear here.** It is not disabled — `PlatformConfigResolver.isFeatureEnabled` falls back to the
 * environment's `FEATURE_<KEY>` check for exactly that case — it simply has no row yet, and the
 * first `PUT` creates one. So this list answers "what has been administered?", not "what flags
 * exist?", and the two questions have different answers until every flag has been touched once.
 */
@Injectable()
export class GetFeatureFlagsQuery {
  constructor(
    @Inject(FEATURE_FLAG_REPOSITORY) private readonly flags: IFeatureFlagRepository,
    private readonly resolver: PlatformConfigResolver,
  ) {}

  async execute(): Promise<FeatureFlagView[]> {
    const rows = await this.flags.listAll();
    return rows.map((row) => this.toView(row));
  }

  /** One flag, or `null` when it has never been administered. */
  async byKey(key: string): Promise<FeatureFlagView | null> {
    const row = await this.flags.findByKey(key.trim().toLowerCase());
    return row ? this.toView(row) : null;
  }

  private toView(row: FeatureFlagProps): FeatureFlagView {
    return {
      key: row.key,
      // Read through the resolver so the reported state is the one a feature module would observe,
      // including the `PARTIAL`-reads-as-off rule, rather than a second interpretation of `status`.
      enabled: this.resolver.isFeatureEnabled(row.key),
      description: row.description,
      updatedBy: row.updatedByUserId,
      updatedAt: row.updatedAt,
    };
  }
}
