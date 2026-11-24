import { Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../../../identity/interface/decorators/public.decorator';
import { CatalogImageService } from '../../application/services/catalog-image.service';

/**
 * Work 150: product pictures uploaded by catalogue staff, served publicly at
 * `/media/catalog/<productId>/<objectId>` (the address saved in the product's `images`). Storage
 * stays private: each request is redirected to a fresh, short-lived signed read of the picture,
 * and browsers may reuse that redirect for a few minutes.
 */
@Controller('media/catalog')
export class CatalogMediaController {
  constructor(private readonly catalogImages: CatalogImageService) {}

  @Get(':productId/:objectId')
  @Public()
  async picture(@Param('productId') productId: string, @Param('objectId') objectId: string, @Res() res: Response): Promise<void> {
    const link = await this.catalogImages.readLink(productId, objectId);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.redirect(302, link.url);
  }
}
