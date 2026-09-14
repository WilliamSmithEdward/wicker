<?php

namespace App\Twig\Components;

use Symfony\UX\TwigComponent\Attribute\AsTwigComponent;

#[AsTwigComponent('Notice')]
final class Alert
{
    public string $message = '';
    public string $tone = 'info';
    private string $internal = '';

    public function mount(bool $dismissible = false): void
    {
    }
}
