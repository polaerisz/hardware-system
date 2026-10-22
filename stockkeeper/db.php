<?php

$host = "127.0.0.1";
$username = "root";
$password = ""; // Sariling password ng database SQL mo.
$database = "stockkeeper_db";
$port = 3306;

$conn = new mysqli(
    $host,
    $username,
    $password,
    $database,
    $port
);

if ($conn->connect_error) {
    http_response_code(500);
    die("Database connection failed.");
}

$conn->set_charset("utf8mb4");

?>
