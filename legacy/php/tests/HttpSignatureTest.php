<?php
declare(strict_types=1);

namespace Bureau\Legacy\Tests;

use PHPUnit\Framework\TestCase;

final class HttpSignatureTest extends TestCase
{
    public function testValidSignedPostAndGetRequestsVerify(): void
    {
        $secret = 'test-bridge-secret';
        $now = 1750000000;

        $postUri = 'http://legacy:8080/v1/requests';
        $postBody = '{"reference":"7e9c52fe-7bb7-4b15-9c87-ec16d001b34c","amountMinor":25000}';
        $postHeaders = sign_http_request('POST', $postUri, $postBody, 'bridge', $secret, $now);

        $this->assertTrue(verify_http_signature(
            'POST',
            $postUri,
            $postBody,
            $postHeaders['Signature-Input'],
            $postHeaders['Signature'],
            $postHeaders['Content-Digest'],
            'bridge',
            $secret,
            $now
        ));

        $getUri = 'http://legacy:8080/v1/accounts';
        $getHeaders = sign_http_request('GET', $getUri, '', 'bridge', $secret, $now);
        $this->assertTrue(verify_http_signature(
            'GET',
            $getUri,
            '',
            $getHeaders['Signature-Input'],
            $getHeaders['Signature'],
            $getHeaders['Content-Digest'],
            'bridge',
            $secret,
            $now + 60
        ));
    }

    public function testRejectsTamperedBodyMethodUriSecretKeyIdAndExpiredTimestamp(): void
    {
        $secret = 'test-bridge-secret';
        $now = 1750000000;
        $uri = 'http://legacy:8080/v1/requests';
        $body = '{"amountMinor":25000}';
        $headers = sign_http_request('POST', $uri, $body, 'bridge', $secret, $now);

        // Tampered payload body
        $this->assertFalse(verify_http_signature(
            'POST',
            $uri,
            '{"amountMinor":99999}',
            $headers['Signature-Input'],
            $headers['Signature'],
            $headers['Content-Digest'],
            'bridge',
            $secret,
            $now
        ));

        // Tampered body with recomputed digest (signature mismatch)
        $tamperedBody = '{"amountMinor":99999}';
        $this->assertFalse(verify_http_signature(
            'POST',
            $uri,
            $tamperedBody,
            $headers['Signature-Input'],
            $headers['Signature'],
            compute_content_digest($tamperedBody),
            'bridge',
            $secret,
            $now
        ));

        // Tampered @target-uri
        $this->assertFalse(verify_http_signature(
            'POST',
            'http://legacy:8080/v1/requests/evil',
            $body,
            $headers['Signature-Input'],
            $headers['Signature'],
            $headers['Content-Digest'],
            'bridge',
            $secret,
            $now
        ));

        // Tampered @method
        $this->assertFalse(verify_http_signature(
            'PUT',
            $uri,
            $body,
            $headers['Signature-Input'],
            $headers['Signature'],
            $headers['Content-Digest'],
            'bridge',
            $secret,
            $now
        ));

        // Wrong keyId (bridge vs ops)
        $this->assertFalse(verify_http_signature(
            'POST',
            $uri,
            $body,
            $headers['Signature-Input'],
            $headers['Signature'],
            $headers['Content-Digest'],
            'ops',
            $secret,
            $now
        ));

        // Outside ±60s window
        $this->assertFalse(verify_http_signature(
            'POST',
            $uri,
            $body,
            $headers['Signature-Input'],
            $headers['Signature'],
            $headers['Content-Digest'],
            'bridge',
            $secret,
            $now + 61
        ));
        $this->assertFalse(verify_http_signature(
            'POST',
            $uri,
            $body,
            $headers['Signature-Input'],
            $headers['Signature'],
            $headers['Content-Digest'],
            'bridge',
            $secret,
            $now - 61
        ));

        // Wrong secret
        $this->assertFalse(verify_http_signature(
            'POST',
            $uri,
            $body,
            $headers['Signature-Input'],
            $headers['Signature'],
            $headers['Content-Digest'],
            'bridge',
            'wrong-secret',
            $now
        ));
    }
}
