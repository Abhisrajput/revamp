pub mod tiers;
pub mod cobol;
pub mod rpg;
pub mod cl;
pub mod dds;
pub mod jcl;
pub mod pli;
pub mod vb6;
pub mod abap;
pub mod sas;
pub mod delphi;
pub mod powerbuilder;
pub mod natural;
pub mod plsql;
pub mod fortran;
pub mod mumps;
pub mod remaining;

use crate::parser::registry::ParserRegistry;

/// Register all available language parsers into the given registry.
/// Call this once at startup to populate the parser registry.
pub fn register_all(registry: &mut ParserRegistry) {
    registry.register(Box::new(cobol::CobolParser));
    registry.register(Box::new(rpg::RpgParser));
    registry.register(Box::new(cl::ClParser));
    registry.register(Box::new(dds::DdsParser));
    registry.register(Box::new(jcl::JclParser));
    registry.register(Box::new(pli::PliParser));
    registry.register(Box::new(vb6::Vb6Parser));
    registry.register(Box::new(abap::AbapParser));
    registry.register(Box::new(sas::SasParser));
    registry.register(Box::new(delphi::DelphiParser));
    registry.register(Box::new(powerbuilder::PowerBuilderParser));
    registry.register(Box::new(natural::NaturalParser));
    registry.register(Box::new(plsql::PlsqlParser));
    registry.register(Box::new(fortran::FortranParser));
    registry.register(Box::new(mumps::MumpsParser));
}
