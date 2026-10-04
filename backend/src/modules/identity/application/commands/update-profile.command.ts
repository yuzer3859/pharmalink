import { Inject, Injectable } from '@nestjs/common';
import { ApiException } from '../../../../shared/errors/api-exception';
import { PreferredLanguage } from '../../domain/enums';
import { IUserRepository, USER_REPOSITORY } from '../../domain/repositories/user.repository';

export interface UpdateProfileInput {
  userId: string;
  preferredLanguage?: 'am' | 'en';
}

export interface UpdateProfileOutput {
  preferredLanguage: string;
}

/**
 * PATCH /users/me (module-01 §11.5). Scope is deliberately narrow: this module owns credentials
 * and locale, while name/photo/address live in Module 02 (Profiles). Changing phone or email is
 * not a profile edit — it re-opens verification, so it belongs to its own flow (§3.2 F-VER).
 */
@Injectable()
export class UpdateProfileCommand {
  constructor(@Inject(USER_REPOSITORY) private readonly users: IUserRepository) {}

  async execute(input: UpdateProfileInput): Promise<UpdateProfileOutput> {
    const user = await this.users.findById(input.userId);
    if (!user) {
      throw ApiException.notFound('User not found');
    }

    if (input.preferredLanguage) {
      user.changeLanguage(
        input.preferredLanguage === 'am' ? PreferredLanguage.am : PreferredLanguage.en,
      );
      await this.users.save(user);
    }

    return { preferredLanguage: user.preferredLanguage };
  }
}
