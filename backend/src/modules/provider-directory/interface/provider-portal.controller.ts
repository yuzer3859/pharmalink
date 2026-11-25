import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { RequirePermissions } from '../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../identity/interface/decorators/current-user.decorator';
import { ProviderPortalService } from '../application/provider-portal.service';
import {
  CreateDepartmentDto,
  CreateLocationDto,
  CreateServiceDto,
  SetFacilitiesDto,
  SetOperatingHoursDto,
  UpdateDepartmentDto,
  UpdateLocationDto,
  UpdateProviderProfileDto,
  UpdateServiceDto,
} from './provider-portal.dto';

const id = (name: string) => Param(name, new ParseUUIDPipe());

/**
 * Work 161: a facility administrator runs their directory profile (module-09 §8.2), with
 * `provider:manage:org` (held by `HOSPITAL_ADMIN` and `DIAGNOSTIC_CENTER_ADMIN`). The facility is
 * the caller's, narrowed by the portal's `X-Organization-Id` when they run several.
 *
 *     GET    /provider/mine                         the facilities I run
 *     GET    /provider/profile                      my facility's full profile
 *     PATCH  /provider/profile                      names, description, website, contacts
 *     POST   /provider/locations                    a location, with its map position
 *     PATCH  /provider/locations/:id                DELETE /provider/locations/:id
 *     PUT    /provider/locations/:id/hours          the week's opening hours
 *     PUT    /provider/locations/:id/facilities     parking, ambulance, …
 *     POST   /provider/departments                  PATCH / DELETE (closes) /provider/departments/:id
 *     POST   /provider/services                     labs and diagnostic centres; PATCH / DELETE /provider/services/:id
 */
@Controller('provider')
@RequirePermissions('provider:manage:org')
export class ProviderPortalController {
  constructor(private readonly portal: ProviderPortalService) {}

  @Get('mine')
  mine(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.portal.mine(user.userId).then((items) => ({ items }));
  }

  @Get('profile')
  profile(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.portal.profile(user.userId);
  }

  @Patch('profile')
  updateProfile(@CurrentUser() user: AuthenticatedPrincipal, @Body() dto: UpdateProviderProfileDto) {
    return this.portal.updateProfile(user.userId, dto);
  }

  @Post('locations')
  @HttpCode(HttpStatus.CREATED)
  createLocation(@CurrentUser() user: AuthenticatedPrincipal, @Body() dto: CreateLocationDto) {
    return this.portal.createLocation(user.userId, dto);
  }

  @Patch('locations/:locationId')
  updateLocation(@CurrentUser() user: AuthenticatedPrincipal, @id('locationId') locationId: string, @Body() dto: UpdateLocationDto) {
    return this.portal.updateLocation(user.userId, locationId, { ...dto });
  }

  @Delete('locations/:locationId')
  removeLocation(@CurrentUser() user: AuthenticatedPrincipal, @id('locationId') locationId: string) {
    return this.portal.removeLocation(user.userId, locationId);
  }

  @Put('locations/:locationId/hours')
  setHours(@CurrentUser() user: AuthenticatedPrincipal, @id('locationId') locationId: string, @Body() dto: SetOperatingHoursDto) {
    return this.portal.setHours(user.userId, locationId, dto.hours);
  }

  @Put('locations/:locationId/facilities')
  setFacilities(@CurrentUser() user: AuthenticatedPrincipal, @id('locationId') locationId: string, @Body() dto: SetFacilitiesDto) {
    return this.portal.setFacilities(user.userId, locationId, dto.facilities);
  }

  @Post('departments')
  @HttpCode(HttpStatus.CREATED)
  createDepartment(@CurrentUser() user: AuthenticatedPrincipal, @Body() dto: CreateDepartmentDto) {
    return this.portal.createDepartment(user.userId, dto);
  }

  @Patch('departments/:departmentId')
  updateDepartment(@CurrentUser() user: AuthenticatedPrincipal, @id('departmentId') departmentId: string, @Body() dto: UpdateDepartmentDto) {
    return this.portal.updateDepartment(user.userId, departmentId, { ...dto });
  }

  @Delete('departments/:departmentId')
  closeDepartment(@CurrentUser() user: AuthenticatedPrincipal, @id('departmentId') departmentId: string) {
    return this.portal.closeDepartment(user.userId, departmentId);
  }

  @Post('services')
  @HttpCode(HttpStatus.CREATED)
  createService(@CurrentUser() user: AuthenticatedPrincipal, @Body() dto: CreateServiceDto) {
    return this.portal.createService(user.userId, dto);
  }

  @Patch('services/:serviceId')
  updateService(@CurrentUser() user: AuthenticatedPrincipal, @id('serviceId') serviceId: string, @Body() dto: UpdateServiceDto) {
    return this.portal.updateService(user.userId, serviceId, { ...dto });
  }

  @Delete('services/:serviceId')
  removeService(@CurrentUser() user: AuthenticatedPrincipal, @id('serviceId') serviceId: string) {
    return this.portal.removeService(user.userId, serviceId);
  }
}
