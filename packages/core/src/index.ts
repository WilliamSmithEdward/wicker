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
  type TemplateContextVariable,
  type TwigVariableContext,
} from './twig/contextVariables.js';

export {
  classToProjectPaths,
  parseComposerManifest,
  projectPathToClass,
  requiresPackage,
  symfonyPackages,
  type ComposerManifest,
  type Psr4Mapping,
} from './project/composer.js';
export {
  discoverSymfonyProject,
  findSymfonyProjects,
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
  MAIN_NAMESPACE_LABEL,
  normalizeLoaderNamespaceKey,
  parseTemplateName,
  type ParsedTemplateName,
  type TemplateNameProblem,
  type TemplateNameProblemKind,
  type TwigTemplateName,
} from './twig/templateName.js';
export { lexTwigRegions, readStringLiterals, type TwigRegion } from './twig/twigLexer.js';
export {
  scanTwigTemplateReferences,
  type TwigReferenceKind,
  type TwigTemplateReference,
} from './twig/twigReferences.js';

export {
  ancestorDirectories,
  isWithinDirectory,
  joinProjectPath,
  normalizeProjectPath,
  normalizeRootPath,
  parentDirectory,
  projectPathBasename,
  projectPathDirname,
  toPosixPath,
  toProjectPath,
} from './util/paths.js';
