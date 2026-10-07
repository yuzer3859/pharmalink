import { Inject, Injectable } from '@nestjs/common';
import { NotificationChannel } from '../../domain/enums';
import {
  DESTINATION_SUPPRESSION_REPOSITORY,
  IDestinationSuppressionRepository,
} from '../../domain/repositories/email-webhook.repository';
import { suppressionKeyOf } from '../../domain/suppression';

/**
 * The send-time suppression check (module-13 Work 18): is this destination — already in Module
 * 01's canonical form — on the suppression list for this channel? Reused by any channel provider;
 * today the e-mail provider.
 */
@Injectable()
export class DestinationSuppressionService {
  constructor(
    @Inject(DESTINATION_SUPPRESSION_REPOSITORY) private readonly suppressions: IDestinationSuppressionRepository,
  ) {}

  isSuppressed(channel: NotificationChannel, canonicalAddress: string): Promise<boolean> {
    return this.suppressions.isSuppressed(channel, suppressionKeyOf(canonicalAddress));
  }
}
