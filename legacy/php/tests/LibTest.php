<?php
declare(strict_types=1);

namespace Bureau\Legacy\Tests;

use DomainException;
use InvalidArgumentException;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use RuntimeException;

final class LibTest extends TestCase
{
    public function testUuidGeneratesValidV4Uuid(): void
    {
        $id1 = uuid();
        $id2 = uuid();

        $this->assertNotSame($id1, $id2);
        $this->assertMatchesRegularExpression(
            '/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/',
            $id1
        );
        $this->assertSame(36, strlen($id1));
        $this->assertSame(strtolower($id1), $id1);
    }

    public function testConfigReturnsEnvironmentValue(): void
    {
        putenv('BUREAU_TEST_KEY=test_val_123');
        $this->assertSame('test_val_123', config('BUREAU_TEST_KEY'));
        putenv('BUREAU_TEST_KEY');
    }

    public function testConfigReturnsFallbackWhenUnset(): void
    {
        putenv('BUREAU_UNSET_KEY');
        $this->assertSame('default_val', config('BUREAU_UNSET_KEY', 'default_val'));
    }

    public function testConfigThrowsWhenMissingAndNoFallback(): void
    {
        putenv('BUREAU_MISSING_KEY');
        $this->expectException(RuntimeException::class);
        $this->expectExceptionMessage('Missing configuration: BUREAU_MISSING_KEY');
        config('BUREAU_MISSING_KEY');
    }

    public function testAllocationSuccess(): void
    {
        $ref = uuid();
        $data = [
            'reference' => $ref,
            'sourceAccount' => 'INS000000001',
            'targetAccount' => 'EMP000000001',
            'amountMinor' => 25000,
            'currency' => 'ZAR',
        ];

        $result = allocation($data);

        $this->assertSame($ref, $result['reference']);
        $this->assertSame('INS000000001', $result['sourceAccount']);
        $this->assertSame('EMP000000001', $result['targetAccount']);
        $this->assertSame(25000, $result['amountMinor']);
        $this->assertSame('ZAR', $result['currency']);
    }

    #[DataProvider('validRoutesProvider')]
    public function testAllocationValidRoutes(string $source, string $target): void
    {
        $ref = uuid();
        $result = allocation([
            'reference' => $ref,
            'sourceAccount' => $source,
            'targetAccount' => $target,
            'amountMinor' => 10000,
            'currency' => 'ZAR',
        ]);

        $this->assertSame($source, $result['sourceAccount']);
        $this->assertSame($target, $result['targetAccount']);
    }

    /**
     * @return list<array{string, string}>
     */
    public static function validRoutesProvider(): array
    {
        return [
            ['INS000000001', 'EMP000000001'],
            ['INS000000001', 'EMP000000002'],
            ['INS000000001', 'EMP000000003'],
            ['EMP000000001', 'BNK000000001'],
            ['EMP000000002', 'BNK000000001'],
            ['BNK000000001', 'EMP000000001'],
            ['BNK000000001', 'EMP000000002'],
        ];
    }

    #[DataProvider('invalidReferenceProvider')]
    public function testAllocationRejectsInvalidReference(mixed $ref): void
    {
        $this->expectException(InvalidArgumentException::class);
        $this->expectExceptionMessage('reference must be a lowercase UUID');
        allocation([
            'reference' => $ref,
            'sourceAccount' => 'INS000000001',
            'targetAccount' => 'EMP000000001',
            'amountMinor' => 25000,
            'currency' => 'ZAR',
        ]);
    }

    /**
     * @return list<array{mixed}>
     */
    public static function invalidReferenceProvider(): array
    {
        return [
            [''],
            ['not-a-uuid'],
            ['12345678-1234-1234-1234-12345678901G'], // non-hex
            [strtoupper(uuid())], // uppercase
            [' 12345678-1234-1234-1234-123456789012'], // leading space
            ['12345678-1234-1234-1234-123456789012 '], // trailing space
            [null],
            [12345],
        ];
    }

    #[DataProvider('invalidRoutesProvider')]
    public function testAllocationRejectsInvalidRoutes(string $source, string $target): void
    {
        $this->expectException(InvalidArgumentException::class);
        $this->expectExceptionMessage('Unsupported demo account');
        allocation([
            'reference' => uuid(),
            'sourceAccount' => $source,
            'targetAccount' => $target,
            'amountMinor' => 25000,
            'currency' => 'ZAR',
        ]);
    }

    /**
     * @return list<array{string, string}>
     */
    public static function invalidRoutesProvider(): array
    {
        return [
            ['EMP000000001', 'INS000000001'], // reverse allocation not permitted
            ['INS000000001', 'BNK000000001'], // insurer directly to bank not permitted
            ['EMP000000003', 'BNK000000001'], // suspended employee cannot payout to bank
            ['BNK000000001', 'EMP000000003'], // return credit to suspended employee not permitted
            ['BNK000000001', 'INS000000001'], // bank to insurer not permitted
            ['UNKNOWN00001', 'EMP000000001'], // unknown source
            ['INS000000001', 'UNKNOWN00001'], // unknown target
        ];
    }

    #[DataProvider('invalidAmountProvider')]
    public function testAllocationRejectsInvalidAmounts(mixed $amount): void
    {
        $this->expectException(InvalidArgumentException::class);
        $this->expectExceptionMessage('Use positive integer cents and ZAR');
        allocation([
            'reference' => uuid(),
            'sourceAccount' => 'INS000000001',
            'targetAccount' => 'EMP000000001',
            'amountMinor' => $amount,
            'currency' => 'ZAR',
        ]);
    }

    /**
     * @return list<array{mixed}>
     */
    public static function invalidAmountProvider(): array
    {
        return [
            [0],
            [-1],
            [-25000],
            [250.50], // float
            ['25000'], // string
            [null],
            [1000000000000], // exceeds 999999999999
        ];
    }

    public function testAllocationRejectsInvalidCurrency(): void
    {
        $this->expectException(InvalidArgumentException::class);
        $this->expectExceptionMessage('Use positive integer cents and ZAR');
        allocation([
            'reference' => uuid(),
            'sourceAccount' => 'INS000000001',
            'targetAccount' => 'EMP000000001',
            'amountMinor' => 25000,
            'currency' => 'USD',
        ]);
    }

    public function testPublicRowTransformation(): void
    {
        $row = [
            'reference' => '7e9c52fe-7bb7-4b15-9c87-ec16d001b34c',
            'source_account' => 'INS000000001',
            'target_account' => 'EMP000000001',
            'amount_minor' => '25000',
            'currency' => 'ZAR',
            'status' => 'POSTED',
            'reason' => 'OK',
            'posting_id' => '7e9c52fe-7bb7-4b15-9c87-ec16d001b34c',
            'batch_id' => 'batch-001',
            'created_at' => '2026-10-25 10:15:30',
            'updated_at' => '2026-10-25 10:15:35',
        ];

        $public = public_row($row);

        $this->assertSame('7e9c52fe-7bb7-4b15-9c87-ec16d001b34c', $public['reference']);
        $this->assertSame('INS000000001', $public['sourceAccount']);
        $this->assertSame('EMP000000001', $public['targetAccount']);
        $this->assertSame(25000, $public['amountMinor']);
        $this->assertIsInt($public['amountMinor']);
        $this->assertSame('ZAR', $public['currency']);
        $this->assertSame('POSTED', $public['status']);
        $this->assertSame('OK', $public['reason']);
        $this->assertSame('7e9c52fe-7bb7-4b15-9c87-ec16d001b34c', $public['postingId']);
        $this->assertSame('batch-001', $public['batchId']);
        $this->assertSame('2026-10-25T10:15:30Z', $public['createdAt']);
        $this->assertSame('2026-10-25T10:15:35Z', $public['updatedAt']);
    }

    public function testCsvTextEscapingAndFormatting(): void
    {
        $columns = ['reference', 'amount', 'formula'];
        $rows = [
            ['ref-1', '100', '=SUM(A1:A2)'],
            ['ref-2', '200', '+1+2'],
            ['ref-3', '300', '-500'],
            ['ref-4', '400', '@malicious'],
            ['ref-5', '500', "\tcmd"],
            ['ref-6', '600', "safe,value"],
        ];

        $csv = csv_text($columns, $rows);

        $this->assertStringContainsString("'=SUM(A1:A2)", $csv);
        $this->assertStringContainsString("'+1+2", $csv);
        $this->assertStringContainsString("'-500", $csv);
        $this->assertStringContainsString("'@malicious", $csv);
        $this->assertStringContainsString("'\tcmd", $csv);
        $this->assertStringContainsString('"safe,value"', $csv);
    }
}
