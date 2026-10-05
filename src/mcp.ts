import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";
import type { Config } from "./config.js";
import { createFx } from "./providers/fx.js";
import {
  createHotelsCasaProvider,
  HOTELSCASA_TIMEOUT_MS,
  HOTELSCASA_TOOLS,
  HOTELSCASA_URL,
} from "./providers/hotelscasa.js";
import { ProviderRegistry } from "./providers/registry.js";
import {
  createTrivagoProvider,
  type TrivagoProvider,
  TRIVAGO_TIMEOUT_MS,
  TRIVAGO_TOOLS,
  TRIVAGO_URL,
} from "./providers/trivago.js";
import type { FxRates } from "./providers/fx.js";
import type { HotelSearchProvider, SnapshotInfo } from "./providers/types.js";
import { UpstreamMcpClient } from "./providers/upstream-mcp.js";
import { Gazetteer } from "./core/anchors.js";
import { HotelMemory } from "./core/hotel-memory.js";
import type { TravelDeps } from "./core/travel.js";
import {
  DEFAULT_DATA_DIR,
  loadDataset,
  readManifest,
  snapshotInfo,
  type AirportRow,
  type BusStationRow,
  type LodgingRow,
  type RetiringRoomRow,
  type StationRow,
} from "./data/datasets.js";
import { createNominatim, createPhoton } from "./providers/geocoders.js";
import { createOsmLodging } from "./providers/osm-lodging.js";
import { createSerpApi, SERPAPI_INFO, type SerpApi } from "./providers/serpapi.js";
import { createXotelo, loadXoteloKeys, type Xotelo } from "./providers/xotelo.js";
import { createOsrm } from "./providers/osrm.js";
import { RetiringRooms } from "./core/retiring.js";
import { registerStayTools } from "./tools/stays.js";
import { registerHotelTools } from "./tools/hotels.js";
import { registerPlaceTools } from "./tools/places.js";
import { registerRatesTool } from "./tools/rates.js";
import { registerTravelTools } from "./tools/travel.js";
import { registerSourcesTool } from "./tools/sources.js";

export { SERVER_NAME, SERVER_VERSION } from "./version.js";

export interface Deps {
  config: Config;
  registry: ProviderRegistry;
  hotelProviders: HotelSearchProvider[];
  /** Per-site price lookups for a single hotel. */
  xotelo: Pick<Xotelo, "rates" | "info">;
  /** Looks one known hotel up in trivago by name (id-checked). */
  trivago: Pick<TrivagoProvider, "lookup" | "info">;
  /** Google's room list for one hotel (SerpApi); null without a key. */
  serp: Pick<SerpApi, "rooms" | "info"> | null;
  fx: { rates(): Promise<FxRates> };
  gazetteer: Gazetteer;
  travel: TravelDeps;
  memory: HotelMemory;
  retiring: RetiringRooms;
  snapshots: () => SnapshotInfo[];
  now: () => Date;
}

/** Builds long-lived dependencies (clients, caches, datasets, provider status) shared by every server instance. */
export function createDeps(config: Config, opts: { dataDir?: string } = {}): Deps {
  const ua = config.HTTP_USER_AGENT;
  const http = { userAgent: ua };
  const registry = new ProviderRegistry(
    config.PROVIDERS_DISABLED,
    () => new Date(),
    config.ENABLE_UNOFFICIAL_SOURCES,
  );

  const fx = createFx(http);
  const trivago = createTrivagoProvider(
    new UpstreamMcpClient("trivago", TRIVAGO_URL, TRIVAGO_TOOLS, TRIVAGO_TIMEOUT_MS, ua).call,
    undefined,
    // Points answer in ~7–10 s; leave room within the per-source deadline to merge the ones that did.
    Math.max(5_000, config.PROVIDER_DEADLINE_MS - 6_000),
  );
  const hotelscasa = createHotelsCasaProvider(
    new UpstreamMcpClient("hotelscasa", HOTELSCASA_URL, HOTELSCASA_TOOLS, HOTELSCASA_TIMEOUT_MS, ua).call,
  );
  const dir = opts.dataDir ?? DEFAULT_DATA_DIR;
  const manifest = readManifest(dir);
  const osmLodging = createOsmLodging(
    loadDataset<LodgingRow>("lodging", dir),
    manifest.datasets.lodging?.built_at ?? null,
  );
  // Inside searches Xotelo scans one list page per area and prices the 5 nearest hotels (each request is
  // ~1.2 s apart); get_hotel_rates fetches full per-site prices for any single hotel.
  const xotelo = createXotelo({
    http,
    keys: loadXoteloKeys(dir),
    maxPagesPerKey: 1,
    ratesForNearest: 5,
    // Leave half the per-source deadline for the request itself (Xotelo answers in ~3–7 s).
    maxQueueWaitMs: config.PROVIDER_DEADLINE_MS / 2,
    // A search's requests must start early enough to finish (~6 s each) before its deadline.
    searchBudgetMs: Math.max(2_000, config.PROVIDER_DEADLINE_MS - 6_000),
  });
  const serpapi = config.SERPAPI_KEY
    ? createSerpApi({ apiKey: config.SERPAPI_KEY, http, maxPages: config.SERPAPI_MAX_PAGES })
    : null;
  // Priced sources first: when listings merge, the first source's id becomes the hotel_id.
  const hotelProviders: HotelSearchProvider[] = [
    trivago,
    hotelscasa,
    xotelo,
    ...(serpapi ? [serpapi] : []),
    osmLodging,
  ];
  const photon = createPhoton(config.PHOTON_URL, http);
  const nominatim = createNominatim(config.NOMINATIM_URL, http);
  const osrm = createOsrm({ carUrl: config.OSRM_URL, footUrl: config.OSRM_FOOT_URL, http });
  registry.register(SERPAPI_INFO, {
    missingKey: !serpapi,
    quotaRemaining: () => serpapi?.quotaRemaining() ?? null,
  });
  for (const info of [
    ...hotelProviders.filter((p) => p !== serpapi).map((p) => p.info),
    fx.info,
    photon.info,
    nominatim.info,
    osrm.info,
  ]) {
    registry.register(info);
  }

  const gazetteer = new Gazetteer({
    stations: loadDataset<StationRow>("stations", dir),
    airports: loadDataset<AirportRow>("airports", dir),
    busStations: loadDataset<BusStationRow>("bus_stations", dir),
    registry,
    geocoders: [
      { id: photon.info.id, search: photon.search },
      { id: nominatim.info.id, search: nominatim.search },
    ],
  });

  return {
    config,
    registry,
    hotelProviders,
    xotelo,
    trivago,
    serp: serpapi,
    fx,
    gazetteer,
    travel: {
      osrm,
      registry,
      metroMultiplier: config.METRO_TRAFFIC_MULTIPLIER,
      otherMultiplier: config.OTHER_TRAFFIC_MULTIPLIER,
    },
    memory: new HotelMemory(),
    retiring: new RetiringRooms(loadDataset<RetiringRoomRow>("retiring_rooms", dir)),
    snapshots: () => snapshotInfo(manifest),
    now: () => new Date(),
  };
}

export function createServer(deps: Deps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Hotel search, price comparison and stay planning across India, around railway stations, airports, " +
        "bus terminals, landmarks and coordinates. Inputs and outputs use plain lat/lng, Indian Railways " +
        "station codes, IATA airport codes and ISO-8601 datetimes. Prices come from third-party meta-search " +
        "sources, may exclude GST, and carry their source and fetch time. Drive times come from OpenStreetMap " +
        "routing without live traffic.",
    },
  );
  registerSourcesTool(server, deps);
  registerPlaceTools(server, deps);
  registerHotelTools(server, {
    registry: deps.registry,
    providers: deps.hotelProviders,
    fx: deps.fx,
    deadlineMs: deps.config.PROVIDER_DEADLINE_MS,
    gazetteer: deps.gazetteer,
    travel: deps.travel,
    memory: deps.memory,
    now: deps.now,
    defaultMinRatingPct: deps.config.DEFAULT_MIN_RATING_PCT,
  });
  registerRatesTool(server, {
    hotels: {
      registry: deps.registry,
      providers: deps.hotelProviders,
      fx: deps.fx,
      deadlineMs: deps.config.PROVIDER_DEADLINE_MS,
    },
    gazetteer: deps.gazetteer,
    xotelo: deps.xotelo,
    trivago: deps.trivago,
    serp: deps.serp,
    memory: deps.memory,
    now: deps.now,
  });
  registerTravelTools(server, deps);
  registerStayTools(server, {
    gazetteer: deps.gazetteer,
    hotels: {
      registry: deps.registry,
      providers: deps.hotelProviders,
      fx: deps.fx,
      deadlineMs: deps.config.PROVIDER_DEADLINE_MS,
    },
    travel: deps.travel,
    retiring: deps.retiring,
    memory: deps.memory,
    defaultMinRatingPct: deps.config.DEFAULT_MIN_RATING_PCT,
    trainBufferMin: deps.config.TRAIN_BUFFER_MIN,
    flightBufferMin: deps.config.FLIGHT_BUFFER_MIN,
    now: deps.now,
  });
  return server;
}
