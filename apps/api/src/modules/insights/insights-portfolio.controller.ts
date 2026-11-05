import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { buildPortfolioReport, reportFileName, utcDay } from '@tvmf/shared';
import { CurrentUser } from '../../auth/auth.decorators';
import type { AuthedUser } from '../../common/request';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { InsightsPortfolioService } from './insights-portfolio.service';
import { renderReportPdf } from './report-pdf';

/** The All customers view (docs/INSIGHTS.md, step 5): across the customers the person can open, so no customer in the path. */
@Controller('insights/portfolio')
export class InsightsPortfolioController {
  constructor(private readonly svc: InsightsPortfolioService) {}

  @Get()
  @RequirePermission('insights:portfolio')
  portfolio(@CurrentUser() user: AuthedUser) {
    return this.svc.portfolio(user);
  }

  @Get('pdf')
  @RequirePermission('insights:portfolio')
  async pdf(@CurrentUser() user: AuthedUser, @Res() res: Response) {
    const doc = buildPortfolioReport(await this.svc.portfolio(user), utcDay());
    const pdf = await renderReportPdf(doc, 'All customers');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${reportFileName(doc, 'all-customers')}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(pdf);
  }
}
