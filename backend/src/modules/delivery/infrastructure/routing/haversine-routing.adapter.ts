import { Injectable } from '@nestjs/common';
import { haversineMeters } from '../../domain/services/dispatch-policy';
import {
  IRoutingPort,
  RouteRequest,
  RouteResult,
} from '../../application/ports/outbound/routing.port';

/**
 * How much further a rider travels than the straight line between two points.
 *
 * **1.35.** Street networks do not go where crows do: a grid forces right angles, rivers and rail
 * lines force detours, and one-way systems add more. The ratio of road distance to great-circle
 * distance is a well-studied quantity for urban networks and sits around 1.2–1.4 for most cities;
 * the upper part of that range suits Addis Ababa, whose road layout is shaped by hills and
 * radial arterials rather than a grid.
 *
 * A constant rather than a config key on purpose. It is a property of *this stand-in's* model of
 * the world, not a business parameter an operator should be tuning — the answer to "our estimates
 * are wrong" is a real routing provider, not a better fudge factor.
 */
const ROAD_WINDING_FACTOR = 1.35;

/**
 * Average door-to-door speed, kilometres per hour.
 *
 * **Twenty-two.** Not a motorcycle's cruising speed, which is far higher, but the average once
 * junctions, lights, congestion and the last hundred metres of finding an address are included.
 * Erring low is deliberate: an estimate that proves pessimistic disappoints nobody, while one that
 * proves optimistic has a customer standing at their door waiting.
 */
const AVERAGE_SPEED_KPH = 22;

/** Below this, "distance" is GPS noise and the honest travel time is zero. */
const ARRIVED_THRESHOLD_METERS = 25;

/**
 * `IRoutingPort` without a routing provider (§7's "computed via mapping adapter (`IRoutingPort`)
 * **or heuristic**", §10's `MockRouting`).
 *
 * ## Why this and not a real provider
 *
 * Because there is no approved one. Every routing vendor needs an account, a key, a contract and a
 * per-request cost, and this repository has no provider configuration for any of them — the same
 * situation Module 07 was in when it shipped `MockPaymentProvider`, and the same answer: a
 * deterministic in-process stand-in, wired by default, performing **no network I/O whatsoever**,
 * so that the whole ETA path is real and exercised before any commercial decision is made. The
 * project's other non-production adapters — the in-memory OTP store, the mock Fayda provider — are
 * used the same way, and `test/support/test-app.ts` describes them as "the project's
 * non-production adapters, used as-is, so the wiring under test is the wiring that ships".
 *
 * Replacing it is a one-file change and no caller moves: bind a real adapter to `ROUTING_PORT`.
 * That is the entire point of the port existing.
 *
 * ## What it actually computes, stated plainly so nobody mistakes it for more
 *
 * Great-circle distance, inflated by a winding factor, divided by an average speed. It knows
 * nothing about roads, turns, one-way streets, traffic, time of day or weather. Its estimates are
 * *plausible and consistent*, which is what a development environment and a test suite need, and
 * they are **not** accurate in the sense a customer would assume. Nothing downstream depends on
 * that accuracy: the ETA is presented as an estimate, and the surrounding machinery — the pickup
 * boundary, the staleness rule, the cache, the failure path — is correct regardless of which
 * implementation produces the numbers.
 *
 * Being deterministic is a feature here rather than a limitation. The same two points always yield
 * the same route, so a test can assert an exact distance and a CI run never depends on a third
 * party being up (§16's "do not depend on an external mapping provider for CI").
 */
@Injectable()
export class HaversineRoutingAdapter implements IRoutingPort {
  async route(request: RouteRequest): Promise<RouteResult | null> {
    const straightLine = haversineMeters(request.origin, request.destination);
    const distanceMeters = straightLine * ROAD_WINDING_FACTOR;

    if (straightLine < ARRIVED_THRESHOLD_METERS) {
      // The driver is effectively there. Reporting a minute's travel because a handset's position
      // wobbles by twenty metres would show a permanent countdown to a customer whose driver is
      // already at the door.
      return { distanceMeters: 0, durationSeconds: 0 };
    }

    const metersPerSecond = (AVERAGE_SPEED_KPH * 1_000) / 3_600;
    return { distanceMeters, durationSeconds: distanceMeters / metersPerSecond };
  }
}
