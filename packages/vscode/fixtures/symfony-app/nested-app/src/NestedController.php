<?php

class NestedController
{
    public function index()
    {
        return $this->render('task/_row.html.twig', ['nestedOnly' => true]);
    }
}
