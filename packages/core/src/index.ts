/**
 * The public surface of the Wicker engine.
 *
 * Everything here is editor-agnostic and free of protocol types, so the same
 * engine can back a VS Code extension, a language server, or a command line
 * tool without change.
 */

export {
  directoryExists,
  fileExists,
  type DirectoryEntry,
  type FileStat,
  type FileType,
  type WickerFileSystem,
} from './fs/fileSystem.js';
export { InMemoryFileSystem } from './fs/inMemoryFileSystem.js';
export { NodeFileSystem } from './fs/nodeFileSystem.js';
export { stimulusCallbackOwners, stimulusClassProperties, stimulusDeclarationRanges, stimulusGeneratedMembers, stimulusIdentifier, stimulusSource, stimulusOutletProperties, stimulusOutletStem, type GeneratedMember, type StimulusController, type StimulusSource, type StimulusMember, type StimulusDispatch, type StimulusValue, type CallbackOwner } from './frontend/stimulus.js';
export { AssetMap, assetExcluded, assetMapperSettings, type AssetMapperSettings, type AssetRoot, type MappedAsset } from './frontend/assetMap.js';
export { parseImportMap, type ImportMapEntry } from './frontend/importMap.js';
export { cssImports, cssUrls, type CssImport } from './frontend/cssImports.js';
export { importSpecifiers, resolveRelativeImport, type ImportSpecifier } from './frontend/imports.js';
export { parseActionDescriptor, ACTION_OPTIONS, COMMON_EVENTS, DEFAULT_EVENTS, EVENT_TARGETS, KEY_FILTERS, type ActionDescriptor } from './frontend/actionDescriptor.js';
export { resolveOutletReference, controllerForReference, outletAccessAt, outletUseRanges,
  type OutletAccess } from './frontend/outlets.js';
export { scanFrontend, stimulusHtmlName, type FrontendReference, type FrontendScan } from './frontend/references.js';
export { routesFromDebug, routeForUrl, endpointActions, type SymfonyRoute, type EndpointAction, type ResponseField } from './frontend/routes.js';
export { FrontendIndex, fetchValueReferences, type FrontendFile, type EndpointUse,
  type IncomingReference } from './frontend/index.js';
export { responseAccessAt, type ResponseAccess } from './frontend/responseAccess.js';

export {
  parseJsonLoosely,
  resolveLoaderPaths,
  type ConsoleResult,
  type ConsoleRunner,
  type LoaderPathSource,
  type LoaderPathsResolution,
} from './console/consoleRunner.js';

export {
  scanTemplateReferences,
  type OffsetRange,
  type TemplateReference,
  type TemplateReferenceKind,
  type TemplateReferenceScan,
} from './php/templateReferences.js';
export { RenderSiteIndex, type RenderSite, type RenderingController } from './php/renderSiteIndex.js';
export {
  templateContextVariables,
  twigVariableContextAt,
  twigScopeAt,
  type TemplateContextVariable,
  type TwigVariableContext,
} from './twig/contextVariables.js';
export { TemplateContextIndex, type TwigContextVariable, type TwigVariableOrigin } from './twig/templateContextIndex.js';

export {
  classToProjectPaths,
  parseComposerManifest,
  type ComposerManifest,
  type Psr4Mapping,
} from './project/composer.js';
export {
  discoverSymfonyProject,
  inspectDirectory,
  isSymfonyProject,
  type SymfonyEvidence,
  type SymfonyProject,
} from './project/discovery.js';
export {
  extensionsFromPatterns,
  loaderPathsFromTwigConfig,
  parseTwigConfig,
  TWIG_CONFIG_PATH,
  type TwigConfig,
} from './project/twigConfig.js';

export {
  DEFAULT_TEMPLATE_DIRECTORY,
  TwigLoaderPaths,
  type LoaderPathEntry,
} from './twig/loaderPaths.js';
export {
  TwigTemplateIndex,
  type IndexedTemplate,
  type TemplateIndexOptions,
} from './twig/templateIndex.js';
export {
  formatTemplateName,
  MAIN_NAMESPACE,
  normalizeLoaderNamespaceKey,
  parseTemplateName,
  type ParsedTemplateName,
  type TemplateNameProblem,
  type TemplateNameProblemKind,
  type TwigTemplateName,
} from './twig/templateName.js';
export { lexTwigRegions, readStringLiterals, type TwigRegion } from './twig/twigLexer.js';
export { componentsFromDebug, componentClassSource, anonymousComponentProps,
  type TwigComponent, type ComponentProp } from './twig/components.js';
export { componentReferenceAt, type ComponentReference } from './twig/componentReferences.js';
export {
  twigCallablesFromDebug,
  callableGroup,
  findTwigCallable,
  scanTwigCallables,
  twigCallableContextAt,
  isConcreteTwigCallable,
  type TwigCallable,
  type TwigCallableKind,
  type TwigCallableCatalog,
} from './twig/callables.js';
export {
  scanTwigTemplateReferences,
  type TwigReferenceKind,
  type TwigTemplateReference,
} from './twig/twigReferences.js';

export {
  ancestorDirectories,
  joinProjectPath,
  normalizeProjectPath,
  normalizeRootPath,
  parentDirectory,
  projectPathBasename,
  projectPathDirname,
  toPosixPath,
  toProjectPath,
} from './util/paths.js';
export { phpTypeDeclarations, type PhpTypeDeclaration, type PhpDependency } from './php/dependencies.js';
export { typescriptSourceForJavascript } from './frontend/sourceMaps.js';
