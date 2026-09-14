import * as vscode from 'vscode';
import { joinProjectPath, outletAccessAt, outletUseRanges, resolveOutletReference, stimulusOutletProperties, stimulusOutletStem, stimulusSource,
  type FrontendReference, type StimulusController, type StimulusSource } from '@wicker/core';
import type { ProjectSession, SessionManager } from './session.js';
import { frontendIndex, ownsFrontendPath } from './frontendProject.js';
import type { FrontendCandidate, FrontendQuery, FrontendTarget, OutletConnection } from './frontendQueries.js';

/** Outlet relationships use registered identifiers and current source buffers.
 * CSS selectors describe a runtime match; they do not prove the rendered DOM. */
export class OutletQueries {
  constructor(private readonly sessions: SessionManager) {}

  async twig(session: ProjectSession, raw: FrontendReference, offset: number): Promise<FrontendQuery | undefined> {
    const ref = resolveOutletReference(raw, this.controllers(session));
    if (!ref?.controller) { return undefined; }
    const host = await this.controllerSource(session, ref.controller);
    if (!host) { return undefined; }
    const onSelector = !!ref.selector && offset >= ref.selector.range.start && offset <= ref.selector.range.end;
    const candidates = host.info.outlets.map((outlet): FrontendCandidate => ({ ...outlet, projectPath: host.controller.projectPath,
      label: `Stimulus outlet · ${ref.controller} → ${outlet.name}`, kind: vscode.CompletionItemKind.Reference,
      documentation: explainOutlet(ref.controller!, outlet.name) }));
    const target = await this.controllerSource(session, ref.name);
    const declaration = candidates.find((candidate) => candidate.name === ref.name);
    const explanation = explainOutlet(ref.controller, ref.name) + (ref.selector
      ? `\n\nSelector: ${ref.selector.name}\nStimulus looks for elements matching this CSS selector with the ${ref.name} controller attached. They can be anywhere on the page, including outside ${ref.controller}'s element.` : '') +
      (!declaration ? `\n\n${ref.controller} has no direct static outlets declaration for ${ref.name}.` : '') +
      (!target ? `\n\nNo readable registered controller named ${ref.name} was found.` : '');
    return { name: onSelector ? ref.selector.name : ref.name, range: onSelector ? ref.selector.range : ref.range,
      candidates: onSelector ? [] : candidates,
      targets: [...(onSelector && declaration ? [declaration] : []), ...(target ? [{ projectPath: target.controller.projectPath,
        range: target.info.range, label: `Connected controller · ${ref.name}` }] : [])],
      documentation: explanation, outlet: { controller: ref.controller, outlet: ref.name }, declarations: declaration ? [declaration] : [] };
  }

  async javascript(session: ProjectSession, path: string, source: string, offset: number): Promise<FrontendQuery | undefined> {
    const controller = this.controllers(session).find((controller) => controller.projectPath === path);
    if (!controller) { return undefined; }
    const info = this.sourceInfo(session, path, source), access = outletAccessAt(source, info, offset);
    if (!access) { return undefined; }
    const declaration = (name: string): FrontendTarget[] => info.outlets.filter((member) => member.name === name)
      .map((member) => ({ ...member, projectPath: path, label: `Outlet declared in ${controller.name}` }));
    if (access.kind === 'declaration') {
      const candidates = this.controllers(session).map((target): FrontendCandidate => ({ ...target, range: { start: 0, end: 0 },
        label: `Stimulus outlet controller · ${target.name}`, kind: vscode.CompletionItemKind.Class,
        documentation: explainOutlet(controller.name, target.name) }));
      return { name: access.name, range: access.range, candidates, ...(access.name ? { documentation: explainOutlet(controller.name, access.name) } : {}),
        outlet: { controller: controller.name, outlet: access.name }, declarations: declaration(access.name) };
    }
    if (access.kind === 'method') {
      const target = await this.controllerSource(session, access.outlet!);
      if (!target) { return undefined; }
      return { name: access.name, range: access.range, candidates: target.info.actions.map((method) => ({ ...method, projectPath: target.controller.projectPath,
        label: `Stimulus outlet method · ${target.controller.name}`, kind: vscode.CompletionItemKind.Method,
        documentation: `Calls ${method.name}() on the ${target.controller.name} controller selected by ${controller.name}'s outlet.` })) };
    }
    const candidates: FrontendCandidate[] = info.outlets.flatMap((outlet) => stimulusOutletProperties(outlet.name).map((property) => ({
      name: property, range: outlet.range, projectPath: path, kind: vscode.CompletionItemKind.Property,
      label: `Stimulus outlet · ${outlet.name}`, documentation: explainProperty(controller.name, outlet.name, property),
    })));
    const outlet = access.outlet ?? info.outlets.find((outlet) => stimulusOutletProperties(outlet.name).includes(access.name))?.name;
    if (access.kind === 'callback') {
      candidates.splice(0, candidates.length, ...declaration(outlet!).map((target) => ({ ...target, name: access.name,
        kind: vscode.CompletionItemKind.Method, documentation: `${access.name}(outlet, element) runs when a matching ${outlet} controller ${access.name.endsWith('Disconnected') ? 'disconnects' : 'connects'}.\n\n${explainOutlet(controller.name, outlet!)}` })));
    }
    return { name: access.name, range: access.range, candidates,
      ...(outlet ? { outlet: { controller: controller.name, outlet }, declarations: declaration(outlet) } : {}) };
  }

  references(session: ProjectSession, connection: OutletConnection): FrontendTarget[] {
    const controllers = this.controllers(session), index = frontendIndex(this.sessions, session);
    const result: FrontendTarget[] = [];
    for (const file of index.all()) {
      for (const raw of file.scan.references) {
        const ref = resolveOutletReference(raw, controllers);
        if (ref?.controller === connection.controller && ref.name === connection.outlet) {
          result.push({ projectPath: file.projectPath, range: ref.range, label: 'Outlet binding' });
        }
      }
      if (file.stimulus && controllers.some((controller) => controller.name === connection.controller && controller.projectPath === file.projectPath)) {
        result.push(...outletUseRanges(file.stimulus, connection.outlet).map((range) => ({ projectPath: file.projectPath, range, label: 'Outlet access' })));
      }
    }
    return result;
  }

  private controllers(session: ProjectSession): readonly StimulusController[] {
    return session.frontend.controllers.filter((controller) => ownsFrontendPath(this.sessions, session, controller.projectPath));
  }
  private async controllerSource(session: ProjectSession, name: string): Promise<{ controller: StimulusController; info: StimulusSource } | undefined> {
    const controller = this.controllers(session).find((controller) => controller.name === name);
    if (!controller) { return undefined; }
    const path = joinProjectPath(session.project.root, controller.projectPath);
    if ((await session.fileSystem.stat(path))?.type !== 'file') { return undefined; }
    try {
      const doc = await vscode.workspace.openTextDocument(session.fileSystem.toUri(path));
      return { controller, info: this.sourceInfo(session, controller.projectPath, doc.getText()) };
    } catch { return undefined; }
  }
  private sourceInfo(session: ProjectSession, path: string, source: string): StimulusSource {
    // The tracker normally parsed this version already. Vendor controllers are
    // deliberately outside its index, so retain a direct-source fallback.
    const cached = session.frontendSources.index.get(path);
    return cached?.source === source && cached.stimulus ? cached.stimulus : stimulusSource(source);
  }
}

function explainOutlet(host: string, outlet: string): string {
  const properties = stimulusOutletProperties(outlet), stem = stimulusOutletStem(outlet);
  return `${host} → ${outlet}\nAn outlet gives this controller access to another controller instance on the page. A target gives it an HTML element inside its own scope.\n\n` +
    `Use this.${stem}Outlet to call that controller's methods. For an optional connection, check this.${properties[4]} first; singular outlet access throws when no matching controller is connected.\n\nUse Find All References to find this outlet's Twig bindings and JS/TS accesses.`;
}
function explainProperty(host: string, outlet: string, property: string): string {
  const meaning = property === stimulusOutletProperties(outlet)[4] ? 'Whether at least one matching controller is connected.'
    : property.endsWith('OutletElements') ? 'All matching controller elements; an empty array when none are connected.'
      : property.endsWith('OutletElement') ? 'The first matching controller element; throws when none is connected.'
        : property.endsWith('Outlets') ? 'All matching controller instances; an empty array when none are connected.'
          : 'The first matching controller instance; throws when none is connected.';
  return `${meaning}\n\n${explainOutlet(host, outlet)}`;
}
