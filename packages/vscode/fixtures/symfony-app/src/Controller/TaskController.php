<?php

namespace App\Controller;

use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\Response;

final class TaskController extends AbstractController
{
    public function index(): Response
    {
        return $this->render('task/index.html.twig', [
            'tasks' => [],
            'openCount' => 0,
        ]);
    }

    public function missing(): Response
    {
        return $this->render('task/does_not_exist.html.twig');
    }

    public function badNamespace(): Response
    {
        return $this->render('@Nope/thing.html.twig');
    }
}
