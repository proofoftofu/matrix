use arcis::*;

#[encrypted]
mod circuits {
    use arcis::*;

    pub struct VerifyPairInput {
        card_a: u8,
        card_b: u8,
    }

    #[instruction]
    pub fn verify_pair(input_ctxt: Enc<Shared, VerifyPairInput>) -> Enc<Shared, u8> {
        let input = input_ctxt.to_arcis();
        let is_match: u8 = if input.card_a == input.card_b { 1 } else { 0 };
        input_ctxt.owner.from_arcis(is_match)
    }
}
