<?php

/**
 * The importmap for the fixture project.
 *
 * The "#" entry is the alias form: a bare specifier that names a file rather
 * than a relative path, which is how a project avoids climbing out through
 * ../../.. . One entry per file, because asset URLs carry a content hash and
 * a directory prefix has none.
 */
return [
    'app' => ['path' => './assets/app.js', 'entrypoint' => true],
    '#fixture/peer' => ['path' => './assets/controllers/wicker_peer_controller.ts'],
    '@hotwired/stimulus' => ['version' => '3.2.2'],
];
