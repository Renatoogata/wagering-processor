import { Controller, Get, Header, Inject } from '@nestjs/common';
import {
  METRICS,
  OPERATIONAL_GAUGES,
  type InMemoryMetrics,
  type OperationalGauges,
} from '../../application/ports/observability';

/**
 * GET /metrics no formato do Prometheus. Aberto como os health checks (rede interna;
 * em produção, exposto só para o scraper). Ver a lista de métricas no ARCHITECTURE.md.
 */
@Controller('metrics')
export class MetricsController {
  constructor(
    @Inject(METRICS) private readonly metrics: InMemoryMetrics,
    @Inject(OPERATIONAL_GAUGES) private readonly gauges: OperationalGauges,
  ) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(): Promise<string> {
    return this.metrics.render(await this.gauges.collect());
  }
}
