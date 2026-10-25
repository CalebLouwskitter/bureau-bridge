<?php
declare(strict_types=1);

namespace Bureau\Legacy\Tests;

use InvalidArgumentException;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class BatchFormatTest extends TestCase
{
    /**
     * Parse a 75-byte (excluding LF) input record according to docs/file-contract.md.
     *
     * @return array{reference: string, sourceAccount: string, targetAccount: string, amountMinor: int, currency: string}
     */
    private function parseInputRecord(string $line): array
    {
        $line = rtrim($line, "\r\n");
        if (strlen($line) !== 75) {
            throw new InvalidArgumentException(sprintf('Input record must be exactly 75 bytes, got %d', strlen($line)));
        }

        $ref = substr($line, 0, 36);
        $source = substr($line, 36, 12);
        $target = substr($line, 48, 12);
        $amountStr = substr($line, 60, 12);
        $currency = substr($line, 72, 3);

        if (!preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/', $ref)) {
            throw new InvalidArgumentException('Reference must be a lowercase UUID');
        }
        if (!ctype_digit($amountStr)) {
            throw new InvalidArgumentException('Amount must be numeric');
        }
        if ($currency !== 'ZAR') {
            throw new InvalidArgumentException('Currency must be ZAR');
        }

        return [
            'reference' => $ref,
            'sourceAccount' => $source,
            'targetAccount' => $target,
            'amountMinor' => (int) $amountStr,
            'currency' => $currency,
        ];
    }

    /**
     * Parse a 139-byte (excluding LF) output record according to docs/file-contract.md.
     *
     * @return array{
     *     reference: string,
     *     sourceAccount: string,
     *     targetAccount: string,
     *     amountMinor: int,
     *     currency: string,
     *     outcome: string,
     *     reason: string,
     *     postingId: string
     * }
     */
    private function parseOutputRecord(string $line): array
    {
        $line = rtrim($line, "\r\n");
        if (strlen($line) !== 139) {
            throw new InvalidArgumentException(sprintf('Output record must be exactly 139 bytes, got %d', strlen($line)));
        }

        $inputPart = $this->parseInputRecord(substr($line, 0, 75));
        $outcome = rtrim(substr($line, 75, 8));
        $reason = rtrim(substr($line, 83, 20));
        $postingId = rtrim(substr($line, 103, 36));

        $validOutcomes = ['POSTED', 'DECLINED', 'CONFLICT', 'NOTFOUND'];
        if (!in_array($outcome, $validOutcomes, true)) {
            throw new InvalidArgumentException(sprintf('Invalid outcome: %s', $outcome));
        }

        return [
            ...$inputPart,
            'outcome' => $outcome,
            'reason' => $reason,
            'postingId' => $postingId,
        ];
    }

    public function testRecordLineExactWidthAndNewline(): void
    {
        $ref = 'c28a4918-0951-4d37-83b6-7ebfb482ea43';
        $row = [
            'reference' => $ref,
            'source_account' => 'INS000000001',
            'target_account' => 'EMP000000001',
            'amount_minor' => 25000,
            'currency' => 'ZAR',
        ];

        $line = record_line($row);

        // 75 ASCII bytes + 1 byte LF = 76 bytes total
        $this->assertSame(76, strlen($line));
        $this->assertStringEndsWith("\n", $line);
        $this->assertStringNotContainsString("\r", $line);

        $recordWithoutLf = substr($line, 0, 75);
        $this->assertSame(75, strlen($recordWithoutLf));

        // Field 1: Reference (1-based: 1, width: 36)
        $this->assertSame($ref, substr($recordWithoutLf, 0, 36));
        // Field 2: Client account (1-based: 37, width: 12)
        $this->assertSame('INS000000001', substr($recordWithoutLf, 36, 12));
        // Field 3: Employee payable account (1-based: 49, width: 12)
        $this->assertSame('EMP000000001', substr($recordWithoutLf, 48, 12));
        // Field 4: Amount in cents (1-based: 61, width: 12)
        $this->assertSame('000000025000', substr($recordWithoutLf, 60, 12));
        // Field 5: Currency (1-based: 73, width: 3)
        $this->assertSame('ZAR', substr($recordWithoutLf, 72, 3));
    }

    #[DataProvider('centsPaddingProvider')]
    public function testRecordLineAmountPaddingWithZeros(int $cents, string $expectedPadded): void
    {
        $row = [
            'reference' => uuid(),
            'source_account' => 'INS000000001',
            'target_account' => 'EMP000000001',
            'amount_minor' => $cents,
            'currency' => 'ZAR',
        ];

        $line = record_line($row);
        $padded = substr($line, 60, 12);

        $this->assertSame(12, strlen($padded));
        $this->assertSame($expectedPadded, $padded);
    }

    /**
     * @return list<array{int, string}>
     */
    public static function centsPaddingProvider(): array
    {
        return [
            [1, '000000000001'],
            [99, '000000000099'],
            [100, '000000000100'],
            [25000, '000000025000'],
            [1000000, '000001000000'],
            [50000000, '000050000000'],
            [999999999999, '999999999999'],
        ];
    }

    public function testRecordLineRoundtripParsing(): void
    {
        $ref = uuid();
        $row = [
            'reference' => $ref,
            'source_account' => 'INS000000001',
            'target_account' => 'EMP000000002',
            'amount_minor' => 1234567,
            'currency' => 'ZAR',
        ];

        $line = record_line($row);
        $parsed = $this->parseInputRecord($line);

        $this->assertSame($row['reference'], $parsed['reference']);
        $this->assertSame($row['source_account'], $parsed['sourceAccount']);
        $this->assertSame($row['target_account'], $parsed['targetAccount']);
        $this->assertSame($row['amount_minor'], $parsed['amountMinor']);
        $this->assertSame($row['currency'], $parsed['currency']);
    }

    public function testBatchTotalsAndChecksumIntegrity(): void
    {
        $rows = [
            [
                'reference' => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                'source_account' => 'INS000000001',
                'target_account' => 'EMP000000001',
                'amount_minor' => 25000,
                'currency' => 'ZAR',
            ],
            [
                'reference' => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                'source_account' => 'INS000000001',
                'target_account' => 'EMP000000002',
                'amount_minor' => 75000,
                'currency' => 'ZAR',
            ],
            [
                'reference' => 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                'source_account' => 'EMP000000001',
                'target_account' => 'BNK000000001',
                'amount_minor' => 10000,
                'currency' => 'ZAR',
            ],
        ];

        $data = '';
        $totalCents = 0;
        foreach ($rows as $row) {
            $data .= record_line($row);
            $totalCents += (int) $row['amount_minor'];
        }

        $this->assertSame(110000, $totalCents);
        $this->assertSame(3 * 76, strlen($data));

        $checksum = hash('sha256', $data);
        $this->assertSame(64, strlen($checksum));

        // Changing even 1 cent in one row must change the SHA-256 checksum
        $tamperedRows = $rows;
        $tamperedRows[0]['amount_minor'] = 25001;
        $tamperedData = '';
        foreach ($tamperedRows as $row) {
            $tamperedData .= record_line($row);
        }
        $this->assertNotSame($checksum, hash('sha256', $tamperedData));
    }

    public function testOutputRecordParsingPosted(): void
    {
        $ref = 'c28a4918-0951-4d37-83b6-7ebfb482ea43';
        // 75 bytes input prefix
        $input = $ref . 'INS000000001' . 'EMP000000001' . '000000025000' . 'ZAR';
        // Outcome (8 bytes): POSTED + 2 spaces
        $outcome = str_pad('POSTED', 8, ' ');
        // Reason (20 bytes): space-padded
        $reason = str_pad('OK', 20, ' ');
        // Posting ID (36 bytes): original reference when posted
        $postingId = $ref;

        $outputLine = $input . $outcome . $reason . $postingId;
        $this->assertSame(139, strlen($outputLine));

        $parsed = $this->parseOutputRecord($outputLine);

        $this->assertSame($ref, $parsed['reference']);
        $this->assertSame('INS000000001', $parsed['sourceAccount']);
        $this->assertSame('EMP000000001', $parsed['targetAccount']);
        $this->assertSame(25000, $parsed['amountMinor']);
        $this->assertSame('ZAR', $parsed['currency']);
        $this->assertSame('POSTED', $parsed['outcome']);
        $this->assertSame('OK', $parsed['reason']);
        $this->assertSame($ref, $parsed['postingId']);
    }

    public function testOutputRecordParsingDeclined(): void
    {
        $ref = 'd45e6789-1234-4567-89ab-cdef01234567';
        $input = $ref . 'INS000000001' . 'EMP000000003' . '000000050000' . 'ZAR';
        $outcome = str_pad('DECLINED', 8, ' ');
        $reason = str_pad('TARGET_SUSPENDED', 20, ' ');
        // Posting ID is 36 spaces when not posted
        $postingId = str_repeat(' ', 36);

        $outputLine = $input . $outcome . $reason . $postingId;
        $this->assertSame(139, strlen($outputLine));

        $parsed = $this->parseOutputRecord($outputLine);

        $this->assertSame($ref, $parsed['reference']);
        $this->assertSame('DECLINED', $parsed['outcome']);
        $this->assertSame('TARGET_SUSPENDED', $parsed['reason']);
        $this->assertSame('', $parsed['postingId']);
    }

    public function testOutputRecordParsingConflict(): void
    {
        $ref = 'e56f7890-2345-4678-9abc-def012345678';
        $input = $ref . 'INS000000001' . 'EMP000000001' . '000000010000' . 'ZAR';
        $outcome = str_pad('CONFLICT', 8, ' ');
        $reason = str_pad('FINGERPRINT_DIFF', 20, ' ');
        $postingId = str_repeat(' ', 36);

        $outputLine = $input . $outcome . $reason . $postingId;
        $parsed = $this->parseOutputRecord($outputLine);

        $this->assertSame('CONFLICT', $parsed['outcome']);
        $this->assertSame('FINGERPRINT_DIFF', $parsed['reason']);
        $this->assertSame('', $parsed['postingId']);
    }

    #[DataProvider('invalidInputLinesProvider')]
    public function testParseInputRecordRejectsInvalidLines(string $line, string $expectedMessage): void
    {
        $this->expectException(InvalidArgumentException::class);
        $this->expectExceptionMessage($expectedMessage);
        $this->parseInputRecord($line);
    }

    /**
     * @return list<array{string, string}>
     */
    public static function invalidInputLinesProvider(): array
    {
        $validRef = 'c28a4918-0951-4d37-83b6-7ebfb482ea43';
        return [
            ['too short', 'Input record must be exactly 75 bytes'],
            [str_repeat('x', 74), 'Input record must be exactly 75 bytes'],
            [str_repeat('x', 76), 'Input record must be exactly 75 bytes'],
            [
                strtoupper($validRef) . 'INS000000001' . 'EMP000000001' . '000000025000' . 'ZAR',
                'Reference must be a lowercase UUID',
            ],
            [
                $validRef . 'INS000000001' . 'EMP000000001' . '00000002500X' . 'ZAR',
                'Amount must be numeric',
            ],
            [
                $validRef . 'INS000000001' . 'EMP000000001' . '000000025000' . 'USD',
                'Currency must be ZAR',
            ],
        ];
    }
}
